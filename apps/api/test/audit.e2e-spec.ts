import type { INestApplication } from '@nestjs/common';
import { AuditService } from '../src/modules/audit/audit.service';
import { SettingsService } from '../src/modules/settings/settings.service';
import { as, createUser, expectErrorEnvelope, webLogin } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

describe('audit trail & settings (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await resetDb();
    app = await createTestApp();
    await createUser({ username: 'root', roles: ['SUPER_ADMIN'] });
    await createUser({ username: 'hruser', roles: ['HR_ADMIN'] });
    await createUser({ username: 'dev', roles: ['EMPLOYEE'] });
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('builds a valid hash chain, including under concurrent writers', async () => {
    const audit = app.get(AuditService);
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      audit.record(prisma, { actorUserId: null, action: 'TEST_EVENT', entityType: 'Test', entityId: String(i), after: { i, nested: { b: 2, a: 1 } } })));
    await prisma.$transaction(async (tx) => {
      await audit.record(tx, { actorUserId: null, action: 'TEST_TX', entityType: 'Test', before: { password: 'secret!' }, after: { ok: true } });
    });

    const s = await webLogin(app, 'root');
    const verify = await as(app, s).get('/api/v1/audit-logs/verify');
    expect(verify.status).toBe(200);
    expect(verify.body.valid).toBe(true);
    expect(verify.body.brokenAtSeq).toBeNull();
    expect(verify.body.checked).toBeGreaterThanOrEqual(22);

    const rows = await prisma.auditLog.findMany({ orderBy: { seq: 'asc' } });
    expect(rows[0].prevHash).toBe('GENESIS');
    for (let i = 1; i < rows.length; i++) expect(rows[i].prevHash).toBe(rows[i - 1].hash);
    const txRow = rows.find((r) => r.action === 'TEST_TX')!;
    expect(txRow.before).toEqual({});
  });

  it('rolls the audit row back with its transaction', async () => {
    const audit = app.get(AuditService);
    await expect(prisma.$transaction(async (tx) => {
      await audit.record(tx, { actorUserId: null, action: 'ROLLED_BACK', entityType: 'Test' });
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await prisma.auditLog.count({ where: { action: 'ROLLED_BACK' } })).toBe(0);
  });

  it('rejects UPDATE and DELETE on audit_logs at the database level, and verify detects tampering', async () => {
    await expect(prisma.$executeRawUnsafe(`UPDATE audit_logs SET action = 'TAMPERED' WHERE seq = 1`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE seq = 1`)).rejects.toThrow(/append-only/);

    // Simulate tampering by someone who can bypass the trigger (a superuser disabling it).
    const s = await webLogin(app, 'root');
    await prisma.$transaction([
      prisma.$executeRawUnsafe('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only'),
      prisma.$executeRawUnsafe(`UPDATE audit_logs SET after = '{"i": 999}'::jsonb WHERE seq = 3`),
      prisma.$executeRawUnsafe('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only'),
    ]);
    const verify = await as(app, s).get('/api/v1/audit-logs/verify');
    expect(verify.body).toMatchObject({ valid: false, brokenAtSeq: '3', checked: 2 });
  });

  it('lists audit logs with filters for AUDIT_READ holders only', async () => {
    const hr = await webLogin(app, 'hruser');
    const res = await as(app, hr).get('/api/v1/audit-logs?action=LOGIN&pageSize=50');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items[0]).toMatchObject({ action: 'LOGIN', entityType: 'Session', actor: { username: expect.any(String) } });
    expect(typeof res.body.items[0].seq).toBe('string');
    const filtered = await as(app, hr).get('/api/v1/audit-logs?entityType=Test&entityId=5');
    expect(filtered.body.total).toBe(1);
    const range = await as(app, hr).get(`/api/v1/audit-logs?from=${encodeURIComponent(new Date(Date.now() + 3600_000).toISOString())}`);
    expect(range.body.total).toBe(0);

    const dev = await webLogin(app, 'dev');
    const denied = await as(app, dev).get('/api/v1/audit-logs');
    expect(denied.status).toBe(403);
    expectErrorEnvelope(denied.body, 'FORBIDDEN');
  });

  describe('settings', () => {
    it('lists every known key with its effective value', async () => {
      const s = await webLogin(app, 'root');
      const res = await as(app, s).get('/api/v1/settings');
      expect(res.status).toBe(200);
      const byKey = Object.fromEntries(res.body.map((r: { key: string; value: unknown }) => [r.key, r.value]));
      expect(byKey).toMatchObject({ 'auth.maxFailedLogins': 5, 'attendance.locationEnforcement': 'ENFORCE', 'company.timezone': 'Asia/Amman' });
      const hr = await webLogin(app, 'hruser');
      expect((await as(app, hr).get('/api/v1/settings')).status).toBe(403);
    });

    it('validates per key, updates, audits and invalidates the cache', async () => {
      const s = await webLogin(app, 'root');
      const settings = app.get(SettingsService);
      expect(await settings.get('auth.sessionHours')).toBe(12);

      const bad = await as(app, s).patch('/api/v1/settings/auth.sessionHours').send({ value: 0 });
      expect(bad.status).toBe(400);
      expectErrorEnvelope(bad.body, 'VALIDATION_FAILED');
      expect((await as(app, s).patch('/api/v1/settings/attendance.locationEnforcement').send({ value: 'MAYBE' })).status).toBe(400);
      expect((await as(app, s).patch('/api/v1/settings/company.timezone').send({ value: 'Mars/Olympus' })).status).toBe(400);
      expect((await as(app, s).patch('/api/v1/settings/no.such.key').send({ value: 1 })).status).toBe(404);
      expect((await as(app, s).patch('/api/v1/settings/auth.sessionHours').send({})).status).toBe(400);

      const ok = await as(app, s).patch('/api/v1/settings/auth.sessionHours').send({ value: 8 });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ key: 'auth.sessionHours', value: 8 });
      expect(await settings.get('auth.sessionHours')).toBe(8);

      await webLogin(app, 'dev');
      const session = await prisma.session.findFirstOrThrow({ where: { user: { username: 'dev' } }, orderBy: { createdAt: 'desc' } });
      const hours = (session.expiresAt.getTime() - session.createdAt.getTime()) / 3_600_000;
      expect(hours).toBeCloseTo(8, 1);

      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'SETTING_UPDATE', entityId: 'auth.sessionHours' } });
      expect(audit.before).toEqual({ value: 12 });
      expect(audit.after).toEqual({ value: 8 });
    });
  });
});
