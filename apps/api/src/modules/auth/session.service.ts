import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { SessionUser } from '@workforce/shared';
import type { AuthUser } from '../../common/auth';
import { Db, PrismaService } from '../../common/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { LAST_SEEN_THROTTLE_MS } from './auth.constants';
import { generateToken, sha256Hex } from './password';

export const PRINCIPAL_INCLUDE = {
  employee: { include: { department: { select: { name: true, nameAr: true } } } },
  roles: { include: { role: { include: { permissions: { include: { permission: { select: { key: true } } } } } } } },
} satisfies Prisma.UserInclude;

export type Principal = Prisma.UserGetPayload<{ include: typeof PRINCIPAL_INCLUDE }>;

export type SessionClient = 'WEB' | 'MOBILE';

export interface IssuedSession {
  sessionId: string;
  token: string;
  csrfToken: string | null;
  expiresAt: Date;
}

/** Users, and their employee record if any, must be active and not deleted. */
export const isPrincipalActive = (u: Pick<Principal, 'isActive' | 'deletedAt' | 'employee'>) =>
  u.isActive && !u.deletedAt && (!u.employee || (u.employee.isActive && !u.employee.deletedAt));

export function toAuthUser(p: Principal, sessionId: string, ip: string): AuthUser {
  const permissions = new Set<string>();
  const roles = new Set<string>();
  const managed = new Set<string>();
  for (const ur of p.roles) {
    roles.add(ur.role.key);
    for (const rp of ur.role.permissions) permissions.add(rp.permission.key);
    if (ur.departmentId) managed.add(ur.departmentId);
  }
  return {
    userId: p.id,
    sessionId,
    username: p.username,
    employeeId: p.employeeId,
    roles: [...roles].sort(),
    permissions,
    managedDepartmentIds: [...managed],
    ip,
  };
}

export function toSessionUser(p: Principal): SessionUser {
  const auth = toAuthUser(p, '', '');
  return {
    id: p.id,
    username: p.username,
    locale: p.locale === 'en' ? 'en' : 'ar',
    roles: auth.roles,
    permissions: [...auth.permissions].sort(),
    employee: p.employee
      ? {
          id: p.employee.id,
          employeeCode: p.employee.employeeCode,
          fullName: p.employee.fullName,
          fullNameAr: p.employee.fullNameAr,
          departmentName: p.employee.department?.name ?? null,
          departmentNameAr: p.employee.department?.nameAr ?? null,
        }
      : null,
    mustChangePassword: p.mustChangePassword,
  };
}

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService, private readonly settings: SettingsService) {}

  async issue(db: Db, userId: string, client: SessionClient, ip: string, userAgent: string | undefined): Promise<IssuedSession> {
    const hours = await this.settings.get('auth.sessionHours');
    const token = generateToken();
    const csrfToken = client === 'WEB' ? generateToken() : null;
    const expiresAt = new Date(Date.now() + hours * 3_600_000);
    const session = await db.session.create({
      data: {
        userId,
        tokenHash: sha256Hex(token),
        csrfHash: csrfToken ? sha256Hex(csrfToken) : null,
        client,
        ipAddress: ip || null,
        userAgent: userAgent?.slice(0, 512) ?? null,
        expiresAt,
      },
    });
    return { sessionId: session.id, token, csrfToken, expiresAt };
  }

  /**
   * Resolves a presented token to an active principal, or null if the session is unusable.
   * Idle timeout (auth.idleMinutes, 0 = off) is judged on the stored lastSeenAt, which is refreshed at most
   * once per LAST_SEEN_THROTTLE_MS, so the effective idle limit is accurate to about a minute.
   * An idle session is revoked so it cannot come back.
   */
  async resolve(token: string, ip: string): Promise<{ user: AuthUser; csrfHash: string | null; mustChangePassword: boolean } | null> {
    if (!token || token.length > 256) return null;
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { user: { include: PRINCIPAL_INCLUDE } },
    });
    const now = Date.now();
    if (!session || session.revokedAt || session.expiresAt.getTime() <= now) return null;
    if (!isPrincipalActive(session.user)) return null;
    const idleMinutes = await this.settings.get('auth.idleMinutes');
    if (idleMinutes > 0 && now - session.lastSeenAt.getTime() > idleMinutes * 60_000) {
      await this.revoke(this.prisma, session.id);
      return null;
    }
    if (now - session.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
      await this.prisma.session.updateMany({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } });
    }
    return {
      user: toAuthUser(session.user, session.id, ip),
      csrfHash: session.csrfHash,
      mustChangePassword: session.user.mustChangePassword,
    };
  }

  async loadPrincipal(db: Db, userId: string): Promise<Principal | null> {
    return db.user.findUnique({ where: { id: userId }, include: PRINCIPAL_INCLUDE });
  }

  async revoke(db: Db, sessionId: string): Promise<void> {
    await db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  /** Revokes every live session of a user, optionally keeping one (e.g. the caller's own). */
  async revokeAllForUser(db: Db, userId: string, exceptSessionId?: string): Promise<number> {
    const res = await db.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date() },
    });
    return res.count;
  }
}
