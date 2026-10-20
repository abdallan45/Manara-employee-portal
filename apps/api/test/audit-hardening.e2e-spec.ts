import { Logger } from '@nestjs/common';
import { AuditService } from '../src/modules/audit/audit.service';
import { computeAuditHash } from '../src/modules/audit/audit-hash';
import { prisma, resetDb } from './helpers';

const KEY_A = 'a'.repeat(32) + '-first-audit-key';
const KEY_B = 'b'.repeat(32) + '-second-audit-key';
const audit = new AuditService();

function setKeys(current?: string, previous?: string) {
  if (current === undefined) delete process.env.AUDIT_HMAC_KEY; else process.env.AUDIT_HMAC_KEY = current;
  if (previous === undefined) delete process.env.AUDIT_HMAC_KEY_PREVIOUS; else process.env.AUDIT_HMAC_KEY_PREVIOUS = previous;
}

async function write(n: number, tag: string) {
  for (let i = 0; i < n; i++) await audit.record(prisma, { actorUserId: null, action: 'TEST', entityType: 'Test', entityId: `${tag}${i}`, after: { i } });
}

beforeEach(async () => {
  setKeys();
  await resetDb();
});
afterAll(async () => {
  setKeys();
  await prisma.$disconnect();
});

describe('append-only tables refuse TRUNCATE', () => {
  it('blocks TRUNCATE of audit_logs and attendance_events, also through CASCADE', async () => {
    await write(1, 't');
    await expect(prisma.$executeRawUnsafe('TRUNCATE audit_logs')).rejects.toThrow(/audit_logs is append-only \(TRUNCATE blocked\)/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE attendance_events')).rejects.toThrow(/attendance_events is append-only \(TRUNCATE blocked\)/);
    // employees -> attendance_events (FK), users -> audit_logs (actor FK)
    await expect(prisma.$executeRawUnsafe('TRUNCATE employees CASCADE')).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE users CASCADE')).rejects.toThrow(/append-only/);
    expect(await prisma.auditLog.count()).toBe(1);
  });

  it('the test helper still resets the database (guards are re-enabled afterwards)', async () => {
    await write(2, 'r');
    await resetDb();
    expect(await prisma.auditLog.count()).toBe(0);
    const guards = await prisma.$queryRaw<{ tgname: string; tgenabled: string }[]>`
      SELECT tgname, tgenabled FROM pg_trigger WHERE tgname IN ('audit_logs_no_truncate', 'attendance_events_no_truncate') ORDER BY tgname`;
    expect(guards).toEqual([{ tgname: 'attendance_events_no_truncate', tgenabled: 'O' }, { tgname: 'audit_logs_no_truncate', tgenabled: 'O' }]);
  });
});

describe('keyed audit chain (AUDIT_HMAC_KEY)', () => {
  it('writes h1: HMAC links when the key is set and verifies them', async () => {
    setKeys(KEY_A);
    await write(4, 'k');
    const rows = await prisma.auditLog.findMany({ orderBy: { seq: 'asc' } });
    expect(rows.every((r) => /^h1:[0-9a-f]{64}$/.test(r.hash))).toBe(true);
    expect(rows[1].prevHash).toBe(rows[0].hash);
    expect(await audit.verify(prisma)).toEqual({ valid: true, checked: 4, brokenAtSeq: null });
  });

  it('accepts legacy rows followed by keyed rows', async () => {
    await write(3, 'legacy');
    setKeys(KEY_A);
    await write(3, 'keyed');
    const rows = await prisma.auditLog.findMany({ orderBy: { seq: 'asc' } });
    expect(rows.map((r) => r.hash.startsWith('h1:'))).toEqual([false, false, false, true, true, true]);
    expect(await audit.verify(prisma)).toEqual({ valid: true, checked: 6, brokenAtSeq: null });
  });

  it('fails on keyed rows when the key is missing or wrong', async () => {
    await write(2, 'legacy');
    setKeys(KEY_A);
    await write(2, 'keyed');
    setKeys();
    expect(await audit.verify(prisma)).toEqual({ valid: false, checked: 2, brokenAtSeq: '3' });
    setKeys(KEY_B);
    expect(await audit.verify(prisma)).toEqual({ valid: false, checked: 2, brokenAtSeq: '3' });
  });

  it('detects a keyed row rewritten without the key, even with a recomputed plain hash', async () => {
    setKeys(KEY_A);
    await write(3, 'k');
    // Someone with database rights (but not the key) edits row 2 and recomputes a legacy hash for it.
    const row = await prisma.auditLog.findFirstOrThrow({ where: { seq: 2n } });
    const forged = computeAuditHash({ ...row, after: { i: 999 } });
    await prisma.$transaction([
      prisma.$executeRawUnsafe('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only'),
      prisma.$executeRawUnsafe(`UPDATE audit_logs SET after = '{"i": 999}'::jsonb, hash = '${forged}' WHERE seq = 2`),
      prisma.$executeRawUnsafe('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only'),
    ]);
    expect(await audit.verify(prisma)).toEqual({ valid: false, checked: 1, brokenAtSeq: '2' });
  });

  it('rejects a legacy row appended after keyed rows (downgrade)', async () => {
    setKeys(KEY_A);
    await write(2, 'k');
    setKeys();
    await write(1, 'plain');
    setKeys(KEY_A);
    expect(await audit.verify(prisma)).toEqual({ valid: false, checked: 2, brokenAtSeq: '3' });
  });

  it('verifies across a key rotation with AUDIT_HMAC_KEY_PREVIOUS, but not an old-key row after new-key rows', async () => {
    setKeys(KEY_A);
    await write(2, 'a');
    setKeys(KEY_B, KEY_A);
    await write(2, 'b');
    expect(await audit.verify(prisma)).toEqual({ valid: true, checked: 4, brokenAtSeq: null });
    // Without the previous key the old rows no longer verify.
    setKeys(KEY_B);
    expect(await audit.verify(prisma)).toEqual({ valid: false, checked: 0, brokenAtSeq: '1' });
    // A row signed with the old key after rows signed with the new key.
    setKeys(KEY_A);
    await write(1, 'late');
    setKeys(KEY_B, KEY_A);
    expect(await audit.verify(prisma)).toEqual({ valid: false, checked: 4, brokenAtSeq: '5' });
  });
});

describe('startup checks', () => {
  const env = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = env;
    jest.restoreAllMocks();
  });

  it('refuses a key shorter than 32 characters', () => {
    setKeys('too-short');
    expect(() => new AuditService().onModuleInit()).toThrow(/AUDIT_HMAC_KEY must be at least 32 characters/);
    setKeys(KEY_A, 'short');
    expect(() => new AuditService().onModuleInit()).toThrow(/AUDIT_HMAC_KEY_PREVIOUS must be at least 32/);
    setKeys(undefined, KEY_A);
    expect(() => new AuditService().onModuleInit()).toThrow(/AUDIT_HMAC_KEY_PREVIOUS is set but AUDIT_HMAC_KEY is not/);
  });

  it('warns in production when the key is missing, and only then', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    process.env.NODE_ENV = 'production';
    new AuditService().onModuleInit();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/AUDIT_HMAC_KEY is not set/));
    warn.mockClear();
    setKeys(KEY_A);
    new AuditService().onModuleInit();
    process.env.NODE_ENV = 'test';
    setKeys();
    new AuditService().onModuleInit();
    expect(warn).not.toHaveBeenCalled();
  });
});
