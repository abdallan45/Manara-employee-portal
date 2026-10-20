import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const AUDIT_GENESIS = 'GENESIS';

/** Advisory-lock key serialising appends to the audit chain (arbitrary constant, "AUDT"). */
export const AUDIT_CHAIN_LOCK_KEY = 0x41554454;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const SECRET_KEY = /^(password|passwordhash|newpassword|currentpassword|token|tokenhash|accesstoken|refreshtoken|sessiontoken|csrftoken|csrfhash|secret)$/i;

/**
 * Converts an arbitrary value into plain JSON (Dates -> ISO, BigInt/Decimal -> string) and drops
 * secret-bearing keys at any depth. The stored JSON is exactly what gets hashed.
 */
export function sanitizeForAudit(value: unknown): JsonValue | null {
  if (value === undefined || value === null) return null;
  const json = JSON.stringify(value, (key, v: unknown) => {
    if (key && SECRET_KEY.test(key)) return undefined;
    if (typeof v === 'bigint') return v.toString();
    return v;
  });
  return json === undefined ? null : (JSON.parse(json) as JsonValue);
}

/** Deterministic JSON: object keys sorted recursively (Postgres jsonb does not preserve key order). */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface HashableAuditRow {
  prevHash: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  createdAt: Date;
}

function auditPayload(row: HashableAuditRow): string {
  return canonicalJson({
    prevHash: row.prevHash,
    actorUserId: row.actorUserId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    before: row.before ?? null,
    after: row.after ?? null,
    ipAddress: row.ipAddress,
    createdAt: row.createdAt.toISOString(),
  });
}

/** Legacy (unkeyed) link: plain SHA-256 hex of the canonical payload. Anyone with write access can recompute it. */
export function computeAuditHash(row: HashableAuditRow): string {
  return createHash('sha256').update(auditPayload(row), 'utf8').digest('hex');
}

/** Prefix of keyed links; rows without it are legacy plain SHA-256 links. */
export const AUDIT_MAC_PREFIX = 'h1:';
export const AUDIT_HMAC_MIN_KEY_LENGTH = 32;

/** Keyed link: 'h1:' + HMAC-SHA256(key, canonical payload). Cannot be recomputed without the key. */
export function computeAuditMac(row: HashableAuditRow, key: string): string {
  return AUDIT_MAC_PREFIX + createHmac('sha256', key).update(auditPayload(row), 'utf8').digest('hex');
}

export const isKeyedAuditHash = (hash: string): boolean => hash.startsWith(AUDIT_MAC_PREFIX);

/** Constant-time string comparison (both are hex digests with an optional prefix). */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The audit HMAC key from AUDIT_HMAC_KEY, or null when unset. A key that is set but shorter than
 * 32 characters is a configuration error (it would give a false sense of protection).
 */
export function auditHmacKeyFromEnv(env: NodeJS.ProcessEnv = process.env, name = 'AUDIT_HMAC_KEY'): string | null {
  const key = env[name];
  if (key === undefined || key === '') return null;
  if (key.length < AUDIT_HMAC_MIN_KEY_LENGTH) {
    throw new Error(`${name} must be at least ${AUDIT_HMAC_MIN_KEY_LENGTH} characters (got ${key.length})`);
  }
  if (key.includes('CHANGE_ME')) throw new Error(`${name} still has the placeholder value from deploy/.env.example`);
  return key;
}

/**
 * Keys used to check keyed links, newest first: AUDIT_HMAC_KEY, then AUDIT_HMAC_KEY_PREVIOUS (kept
 * after a rotation so older rows still verify). New rows are always written with AUDIT_HMAC_KEY.
 */
export function auditHmacKeysFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const current = auditHmacKeyFromEnv(env, 'AUDIT_HMAC_KEY');
  const previous = auditHmacKeyFromEnv(env, 'AUDIT_HMAC_KEY_PREVIOUS');
  if (previous && !current) throw new Error('AUDIT_HMAC_KEY_PREVIOUS is set but AUDIT_HMAC_KEY is not');
  return [current, previous].filter((k): k is string => k !== null);
}
