import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AuditLog, Prisma, PrismaClient } from '@prisma/client';
import type { AuditLogDto, AuditVerifyResult, Paginated } from '@workforce/shared';
import type { Db } from '../../common/prisma.service';
import {
  AUDIT_CHAIN_LOCK_KEY, AUDIT_GENESIS, auditHmacKeysFromEnv, computeAuditHash, computeAuditMac, HashableAuditRow, isKeyedAuditHash,
  JsonValue, sameHash, sanitizeForAudit,
} from './audit-hash';

export interface AuditEntry {
  actorUserId: string | null;
  action: string;            // e.g. EMPLOYEE_CREATE, ATTENDANCE_CHECK_IN, ATTENDANCE_DENIED_LOCATION
  entityType: string;        // e.g. Employee, AttendanceEvent
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
}

export interface AuditQuery {
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  action?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

const isRootClient = (db: Db): db is PrismaClient => typeof (db as PrismaClient).$transaction === 'function';
const toDbJson = (v: JsonValue | null) => (v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));

/**
 * Append-only, hash-chained audit trail. Pass the transaction client when the audited change
 * happens inside a transaction so the audit row commits or rolls back with it.
 *
 * With AUDIT_HMAC_KEY set, each link is 'h1:' + HMAC-SHA256(key, canonical row), so someone who can
 * write to the database but does not hold the key cannot rebuild the chain after editing it.
 * Without the key, links are plain SHA-256 (legacy). A chain may start with legacy links and
 * continue with keyed ones, never the other way round. The key is read from the environment on
 * each use (tests switch it); onModuleInit validates it once at startup.
 */
@Injectable()
export class AuditService implements OnModuleInit {
  private readonly logger = new Logger('Audit');

  onModuleInit(): void {
    const keys = auditHmacKeysFromEnv(); // throws on a key that is too short
    if (keys.length === 0 && process.env.NODE_ENV === 'production') {
      this.logger.warn('AUDIT_HMAC_KEY is not set: the audit chain uses plain SHA-256 and can be rebuilt by anyone with database write access. Set a random key of 32+ characters.');
    }
  }

  async record(db: Db, entry: AuditEntry): Promise<void> {
    if (isRootClient(db)) {
      await db.$transaction((tx) => this.append(tx, entry));
      return;
    }
    await this.append(db, entry);
  }

  private async append(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    // Serialises chain appends across connections; released automatically at commit/rollback.
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`);
    const last = await tx.auditLog.findFirst({ orderBy: { seq: 'desc' }, select: { hash: true } });
    const before = sanitizeForAudit(entry.before);
    const after = sanitizeForAudit(entry.after);
    const row = {
      prevHash: last?.hash ?? AUDIT_GENESIS,
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      before,
      after,
      ipAddress: entry.ipAddress ?? null,
      createdAt: new Date(),
    };
    const [key] = auditHmacKeysFromEnv();
    const hash = key ? computeAuditMac(row, key) : computeAuditHash(row);
    await tx.auditLog.create({ data: { ...row, before: toDbJson(before), after: toDbJson(after), hash } });
  }

  async list(db: Db, q: AuditQuery): Promise<Paginated<AuditLogDto>> {
    const where: Prisma.AuditLogWhereInput = {
      entityType: q.entityType,
      entityId: q.entityId,
      actorUserId: q.actorUserId,
      action: q.action,
      createdAt: q.from || q.to ? { gte: q.from, lte: q.to } : undefined,
    };
    const [total, rows] = await Promise.all([
      db.auditLog.count({ where }),
      db.auditLog.findMany({
        where,
        orderBy: { seq: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { actor: { select: { id: true, username: true } } },
      }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        seq: r.seq.toString(),
        actor: r.actor,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        before: r.before,
        after: r.after,
        ipAddress: r.ipAddress,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  /**
   * Recomputes every link in sequence order; reports the first row whose link or content does not
   * match. Fails on a keyed row when no key is configured, on a keyed row whose MAC matches no
   * configured key, on a legacy row after a keyed one, and on a row signed with an older key after
   * one signed with a newer key.
   */
  async verify(db: Db): Promise<AuditVerifyResult> {
    const keys = auditHmacKeysFromEnv();
    const batch = 1000;
    let expectedPrev = AUDIT_GENESIS;
    let checked = 0;
    let cursor: bigint | null = null;
    // Index (in `keys`) of the newest key seen so far; Infinity = only legacy rows so far.
    let newestKeyIndex = Number.POSITIVE_INFINITY;
    for (;;) {
      const rows: AuditLog[] = await db.auditLog.findMany({
        where: cursor === null ? undefined : { seq: { gt: cursor } },
        orderBy: { seq: 'asc' },
        take: batch,
      });
      for (const r of rows) {
        const problem = r.prevHash !== expectedPrev ? 'previous-hash link does not match' : this.checkLink(r, keys, newestKeyIndex);
        if (typeof problem === 'string') {
          this.logger.warn(`Audit chain broken at seq ${r.seq}: ${problem}`);
          return { valid: false, checked, brokenAtSeq: r.seq.toString() };
        }
        newestKeyIndex = problem;
        expectedPrev = r.hash;
        checked++;
      }
      if (rows.length < batch) break;
      cursor = rows[rows.length - 1].seq;
    }
    return { valid: true, checked, brokenAtSeq: null };
  }

  /** The newest-key index after this row, or a reason why the row's own hash is not acceptable. */
  private checkLink(row: HashableAuditRow & { hash: string }, keys: string[], newestKeyIndex: number): number | string {
    if (!isKeyedAuditHash(row.hash)) {
      if (newestKeyIndex !== Number.POSITIVE_INFINITY) return 'unkeyed row after keyed rows';
      return sameHash(computeAuditHash(row), row.hash) ? newestKeyIndex : 'content does not match its hash';
    }
    if (keys.length === 0) return 'keyed row but AUDIT_HMAC_KEY is not configured';
    const index = keys.findIndex((key) => sameHash(computeAuditMac(row, key), row.hash));
    if (index < 0) return 'content does not match its MAC under any configured key';
    if (index > newestKeyIndex) return 'row signed with an older key after rows signed with a newer key';
    return index;
  }
}
