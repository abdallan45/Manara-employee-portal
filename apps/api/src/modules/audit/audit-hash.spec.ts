import { createHash, createHmac } from 'node:crypto';
import {
  auditHmacKeysFromEnv, canonicalJson, computeAuditHash, computeAuditMac, HashableAuditRow, isKeyedAuditHash, sameHash, sanitizeForAudit,
} from './audit-hash';

const base: HashableAuditRow = {
  prevHash: 'GENESIS',
  actorUserId: '00000000-0000-0000-0000-000000000001',
  action: 'EMPLOYEE_CREATE',
  entityType: 'Employee',
  entityId: 'e1',
  before: null,
  after: { b: 1, a: { d: [1, 2], c: 'x' } },
  ipAddress: '127.0.0.1',
  createdAt: new Date('2026-10-17T10:00:00.123Z'),
};

describe('canonicalJson', () => {
  it('sorts keys recursively and is independent of insertion order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson({ a: { c: 3, d: 2 }, b: 1 })).toBe(canonicalJson({ b: 1, a: { d: 2, c: 3 } }));
  });

  it('keeps array order and encodes scalars as JSON', () => {
    expect(canonicalJson([3, 'a', null, true])).toBe('[3,"a",null,true]');
    expect(canonicalJson('é"')).toBe('"é\\""');
  });
});

describe('computeAuditHash', () => {
  it('is SHA-256 over the canonical payload', () => {
    const expected = createHash('sha256').update(canonicalJson({
      prevHash: base.prevHash, actorUserId: base.actorUserId, action: base.action, entityType: base.entityType,
      entityId: base.entityId, before: null, after: base.after, ipAddress: base.ipAddress, createdAt: '2026-10-17T10:00:00.123Z',
    })).digest('hex');
    expect(computeAuditHash(base)).toBe(expected);
    expect(computeAuditHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on key order of before/after (jsonb reorders keys)', () => {
    expect(computeAuditHash({ ...base, after: { a: { c: 'x', d: [1, 2] }, b: 1 } })).toBe(computeAuditHash(base));
  });

  it('changes when any field or the previous hash changes', () => {
    const h = computeAuditHash(base);
    expect(computeAuditHash({ ...base, prevHash: 'x' })).not.toBe(h);
    expect(computeAuditHash({ ...base, action: 'EMPLOYEE_UPDATE' })).not.toBe(h);
    expect(computeAuditHash({ ...base, after: { b: 2, a: { d: [1, 2], c: 'x' } } })).not.toBe(h);
    expect(computeAuditHash({ ...base, createdAt: new Date('2026-10-17T10:00:00.124Z') })).not.toBe(h);
  });
});

describe('sanitizeForAudit', () => {
  it('drops secrets at any depth and normalises values to JSON', () => {
    const out = sanitizeForAudit({
      username: 'u', password: 'p', passwordHash: 'h', nested: { tokenHash: 't', csrfHash: 'c', keep: 1 },
      when: new Date('2026-01-01T00:00:00.000Z'), big: BigInt(5), missing: undefined,
    });
    expect(out).toEqual({ username: 'u', nested: { keep: 1 }, when: '2026-01-01T00:00:00.000Z', big: '5' });
  });

  it('maps undefined and null to null', () => {
    expect(sanitizeForAudit(undefined)).toBeNull();
    expect(sanitizeForAudit(null)).toBeNull();
  });
});

describe('computeAuditMac', () => {
  const key = 'k'.repeat(40);

  it("is 'h1:' + HMAC-SHA256(key, canonical payload)", () => {
    const payload = canonicalJson({
      prevHash: base.prevHash, actorUserId: base.actorUserId, action: base.action, entityType: base.entityType,
      entityId: base.entityId, before: null, after: base.after, ipAddress: base.ipAddress, createdAt: '2026-10-17T10:00:00.123Z',
    });
    expect(computeAuditMac(base, key)).toBe(`h1:${createHmac('sha256', key).update(payload).digest('hex')}`);
    expect(isKeyedAuditHash(computeAuditMac(base, key))).toBe(true);
    expect(isKeyedAuditHash(computeAuditHash(base))).toBe(false);
  });

  it('depends on the key and on the content', () => {
    const mac = computeAuditMac(base, key);
    expect(computeAuditMac(base, 'x'.repeat(40))).not.toBe(mac);
    expect(computeAuditMac({ ...base, action: 'OTHER' }, key)).not.toBe(mac);
    expect(sameHash(mac, computeAuditMac(base, key))).toBe(true);
    expect(sameHash(mac, mac.slice(0, -1))).toBe(false);
  });
});

describe('auditHmacKeysFromEnv', () => {
  it('reads the current and previous keys, newest first', () => {
    expect(auditHmacKeysFromEnv({})).toEqual([]);
    expect(auditHmacKeysFromEnv({ AUDIT_HMAC_KEY: '' })).toEqual([]);
    expect(auditHmacKeysFromEnv({ AUDIT_HMAC_KEY: 'a'.repeat(32), AUDIT_HMAC_KEY_PREVIOUS: 'b'.repeat(32) })).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
  });

  it('refuses short keys and a previous key without a current one', () => {
    expect(() => auditHmacKeysFromEnv({ AUDIT_HMAC_KEY: 'a'.repeat(31) })).toThrow(/at least 32/);
    expect(() => auditHmacKeysFromEnv({ AUDIT_HMAC_KEY_PREVIOUS: 'b'.repeat(32) })).toThrow(/AUDIT_HMAC_KEY is not/);
    expect(() => auditHmacKeysFromEnv({ AUDIT_HMAC_KEY: 'CHANGE_ME_at_least_32_random_characters' })).toThrow(/placeholder/);
  });
});
