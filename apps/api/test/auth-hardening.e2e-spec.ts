// Auth & session hardening: demo-mode gating, lockout design, request guards, idle timeout,
// logout-all, forced password change, admin resets, Swagger gating, page limits and the seed modes.
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { runSeed, seedClient, seedPlan } from '../prisma/seed';
import { AppModule } from '../src/app.module';
import { configureApp, swaggerEnabled } from '../src/app.setup';
import { LoginAttemptLimiter } from '../src/modules/auth/login-attempts';
import { isLoopbackPeer, logDemoModeStatus, isDemoMode } from '../src/modules/auth/auth.constants';
import { as, bearerLogin, createUser, expectErrorEnvelope, TEST_PASSWORD, webLogin } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

/** Boots the app with an extra middleware mounted before configureApp (e.g. to fake the TCP peer). */
async function createAppWith(before?: (req: Request, res: Response, next: NextFunction) => void): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  if (before) app.use(before);
  configureApp(app);
  await app.init();
  return app;
}

const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

describe('auth hardening (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  const login = (username: string, password: string, ip?: string) => {
    const r = http().post('/api/v1/auth/login');
    if (ip) r.set('X-Forwarded-For', ip);
    return r.send({ username, password });
  };

  beforeAll(async () => {
    await resetDb();
    // Trust the loopback "proxy" so tests can present different client IPs via X-Forwarded-For.
    process.env.TRUSTED_PROXIES = 'loopback';
    app = await createTestApp();
    delete process.env.TRUSTED_PROXIES;
    await createUser({ username: 'emp', roles: ['EMPLOYEE'] });
    await createUser({ username: 'boss', roles: ['SUPER_ADMIN', 'EMPLOYEE'] });
    await createUser({ username: 'hrperson', roles: ['HR_ADMIN', 'EMPLOYEE'] });
  });
  beforeEach(() => app.get(LoginAttemptLimiter).reset());
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('demo mode', () => {
    it('is ignored in production, with an error at startup', async () => {
      await withEnv({ DEMO_MODE: 'true', NODE_ENV: 'production' }, async () => {
        expect(isDemoMode()).toBe(false);
        const logger = { error: jest.fn(), warn: jest.fn() };
        expect(logDemoModeStatus(logger)).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/IGNORED/));
        expect((await http().get('/api/v1/auth/demo/accounts')).status).toBe(404);
        expect((await http().post('/api/v1/auth/demo/login').send({ username: 'emp' })).status).toBe(404);
      });
      await withEnv({ DEMO_MODE: 'true' }, async () => {
        const logger = { error: jest.fn(), warn: jest.fn() };
        expect(logDemoModeStatus(logger)).toBe(true);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/DEMO MODE IS ON/));
      });
    });

    it('excludes SUPER_ADMIN / HR_ADMIN accounts unless DEMO_INCLUDE_ADMINS=true', async () => {
      await withEnv({ DEMO_MODE: 'true', DEMO_INCLUDE_ADMINS: undefined }, async () => {
        const list = await http().get('/api/v1/auth/demo/accounts');
        expect(list.status).toBe(200);
        const names = list.body.map((a: { username: string }) => a.username);
        expect(names).toContain('emp');
        expect(names).not.toContain('boss');
        expect(names).not.toContain('hrperson');
        expect((await http().post('/api/v1/auth/demo/login').send({ username: 'boss' })).status).toBe(404);
        expect((await http().post('/api/v1/auth/demo/login').send({ username: 'hrperson' })).status).toBe(404);
        expect((await http().post('/api/v1/auth/demo/login').send({ username: 'emp' })).status).toBe(200);
      });
      await withEnv({ DEMO_MODE: 'true', DEMO_INCLUDE_ADMINS: 'true' }, async () => {
        const names = (await http().get('/api/v1/auth/demo/accounts')).body.map((a: { username: string }) => a.username);
        expect(names).toEqual(expect.arrayContaining(['boss', 'hrperson', 'emp']));
        expect((await http().post('/api/v1/auth/demo/login').send({ username: 'boss' })).status).toBe(200);
      });
    });

    it('answers only loopback TCP peers unless DEMO_ALLOW_REMOTE=true (X-Forwarded-For does not help)', async () => {
      expect(isLoopbackPeer({ socket: { remoteAddress: '127.0.0.1' } })).toBe(true);
      expect(isLoopbackPeer({ socket: { remoteAddress: '::1' } })).toBe(true);
      expect(isLoopbackPeer({ socket: { remoteAddress: '::ffff:127.0.0.1' } })).toBe(true);
      expect(isLoopbackPeer({ socket: { remoteAddress: '192.168.1.20' } })).toBe(false);
      expect(isLoopbackPeer({ socket: undefined })).toBe(false);

      const remote = await withTrustedLoopback(() => createAppWith((req, _res, next) => {
        Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.1.77', configurable: true });
        next();
      }));
      try {
        const r = () => request(remote.getHttpServer());
        await withEnv({ DEMO_MODE: 'true' }, async () => {
          expect((await r().get('/api/v1/auth/demo/accounts').set('X-Forwarded-For', '127.0.0.1')).status).toBe(404);
          expect((await r().post('/api/v1/auth/demo/login').send({ username: 'emp' })).status).toBe(404);
        });
        await withEnv({ DEMO_MODE: 'true', DEMO_ALLOW_REMOTE: 'true' }, async () => {
          expect((await r().get('/api/v1/auth/demo/accounts')).status).toBe(200);
          expect((await r().post('/api/v1/auth/demo/login').send({ username: 'emp' })).status).toBe(200);
        });
      } finally {
        await remote.close();
      }
    });
  });

  describe('lockout', () => {
    beforeEach(async () => {
      await prisma.user.updateMany({ data: { failedLoginCount: 0, lockedUntil: null } });
    });

    it('answers a wrong password with 401 even while locked, and a correct one with 423', async () => {
      for (let i = 0; i < 5; i++) expect((await login('emp', 'wrong-password-x', '10.0.0.1')).status).toBe(401);
      const wrongWhileLocked = await login('emp', 'wrong-password-x', '10.0.0.1');
      expect(wrongWhileLocked.status).toBe(401);
      expectErrorEnvelope(wrongWhileLocked.body, 'INVALID_CREDENTIALS');
      const right = await login('emp', TEST_PASSWORD, '10.0.0.1');
      expect(right.status).toBe(423);
      expectErrorEnvelope(right.body, 'ACCOUNT_LOCKED');

      // Every failure is audited, including those during the lock; never the password.
      const rows = await prisma.auditLog.findMany({ where: { action: { in: ['LOGIN_FAILED', 'ACCOUNT_LOCKED'] }, ipAddress: '10.0.0.1' } });
      expect(rows.length).toBe(7);
      expect(rows.filter((r) => r.action === 'ACCOUNT_LOCKED')).toHaveLength(1);
      expect(rows.some((r) => (r.after as { whileLocked?: boolean }).whileLocked === true)).toBe(true);
      expect(rows.some((r) => (r.after as { reason?: string }).reason === 'LOCKED')).toBe(true);
      expect(JSON.stringify(rows.map((r) => r.after))).not.toMatch(/wrong-password-x|test-password-123/);
    });

    it('locks only the (username, IP) pair: the same user still signs in from another IP', async () => {
      for (let i = 0; i < 5; i++) await login('emp', 'wrong-password-x', '10.0.0.2');
      expect((await login('emp', TEST_PASSWORD, '10.0.0.2')).status).toBe(423);
      expect((await login('emp', TEST_PASSWORD, '10.0.0.3')).status).toBe(200);
    });

    it('treats unknown users like wrong passwords (401, audited), never 423', async () => {
      for (let i = 0; i < 7; i++) {
        const r = await login('ghost-user', 'whatever-123', '10.0.0.4');
        expect(r.status).toBe(401);
        expectErrorEnvelope(r.body, 'INVALID_CREDENTIALS');
      }
      expect(await prisma.auditLog.count({ where: { ipAddress: '10.0.0.4', action: { in: ['LOGIN_FAILED', 'ACCOUNT_LOCKED'] } } })).toBe(7);
    });

    it('keeps the per-user database counter consistent under 20 parallel wrong logins and locks at 4x max', async () => {
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => login('emp', 'wrong-password-x', `10.1.0.${i + 1}`)));
      expect(results.every((r) => r.status === 401)).toBe(true);
      const u = await prisma.user.findUniqueOrThrow({ where: { username: 'emp' } });
      expect(u.failedLoginCount).toBe(20);
      expect(u.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
      // User-level lock applies from any IP, only revealed with the right password.
      expect((await login('emp', 'wrong-password-x', '10.2.0.1')).status).toBe(401);
      expect((await login('emp', TEST_PASSWORD, '10.2.0.1')).status).toBe(423);
      // Counter is not reset by locking; it keeps counting.
      expect((await prisma.user.findUniqueOrThrow({ where: { username: 'emp' } })).failedLoginCount).toBe(21);
      await prisma.user.update({ where: { username: 'emp' }, data: { lockedUntil: null, failedLoginCount: 0 } });
    });

    it('resets counters on successful sign-in', async () => {
      await login('emp', 'wrong-password-x', '10.0.0.5');
      expect((await login('emp', TEST_PASSWORD, '10.0.0.5')).status).toBe(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { username: 'emp' } })).failedLoginCount).toBe(0);
    });
  });

  describe('request guards', () => {
    it('refuses form-encoded and text bodies with 415 before authentication', async () => {
      const form = await http().post('/api/v1/auth/login').type('form').send('username=emp&password=test-password-123');
      expect(form.status).toBe(415);
      expectErrorEnvelope(form.body, 'UNSUPPORTED_MEDIA_TYPE');
      const text = await http().post('/api/v1/auth/login').set('Content-Type', 'text/plain').send('{"username":"emp"}');
      expect(text.status).toBe(415);
      // JSON with a charset is fine.
      const ok = await http().post('/api/v1/auth/login').set('Content-Type', 'application/json; charset=utf-8')
        .send(JSON.stringify({ username: 'emp', password: TEST_PASSWORD }));
      expect(ok.status).toBe(200);
    });

    it('refuses cross-site requests (Origin or Sec-Fetch-Site), allows same-origin and no-Origin', async () => {
      const evil = await http().post('/api/v1/auth/login').set('Origin', 'https://evil.example').send({ username: 'emp', password: TEST_PASSWORD });
      expect(evil.status).toBe(403);
      expectErrorEnvelope(evil.body, 'CSRF_FAILED');
      const nullOrigin = await http().post('/api/v1/auth/login').set('Origin', 'null').send({ username: 'emp', password: TEST_PASSWORD });
      expect(nullOrigin.status).toBe(403);
      const fetchSite = await http().post('/api/v1/auth/login').set('Sec-Fetch-Site', 'cross-site').send({ username: 'emp', password: TEST_PASSWORD });
      expect(fetchSite.status).toBe(403);
      await withEnv({ DEMO_MODE: 'true' }, async () => {
        const demo = await http().post('/api/v1/auth/demo/login').set('Origin', 'https://evil.example').send({ username: 'emp' });
        expect(demo.status).toBe(403);
      });

      const host = `127.0.0.1:${(app.getHttpServer().address() ?? { port: 0 }).port}`;
      const same = await http().post('/api/v1/auth/login').set('Host', host).set('Origin', `http://${host}`).send({ username: 'emp', password: TEST_PASSWORD });
      expect(same.status).toBe(200);
      const noOrigin = await http().post('/api/v1/auth/login').send({ username: 'emp', password: TEST_PASSWORD });
      expect(noOrigin.status).toBe(200);
      // Safe methods are not checked.
      expect((await http().get('/api/v1/health').set('Origin', 'https://evil.example')).status).toBe(200);
      // Explicitly allowed dev origin.
      await withEnv({ ALLOWED_ORIGINS: 'http://localhost:3001' }, async () => {
        const dev = await http().post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ username: 'emp', password: TEST_PASSWORD });
        expect(dev.status).toBe(200);
      });
    });

    it('returns a generic message for malformed JSON', async () => {
      const r = await http().post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{"username": "emp", oops');
      expect(r.status).toBe(400);
      expectErrorEnvelope(r.body, 'VALIDATION_FAILED');
      expect(r.body.error.message).toBe('Malformed JSON body');
      expect(JSON.stringify(r.body)).not.toMatch(/oops|position|Unexpected/);
    });
  });

  describe('sessions', () => {
    it('ends idle sessions (auth.idleMinutes) and revokes them', async () => {
      const s = await webLogin(app, 'emp');
      const session = await prisma.session.findFirstOrThrow({ where: { user: { username: 'emp' }, revokedAt: null }, orderBy: { createdAt: 'desc' } });
      await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(Date.now() - 61 * 60_000) } });
      const r = await as(app, s).get('/api/v1/auth/me');
      expect(r.status).toBe(401);
      expectErrorEnvelope(r.body, 'UNAUTHENTICATED');
      expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).revokedAt).not.toBeNull();

      // A recently used session is fine.
      const fresh = await webLogin(app, 'emp');
      expect((await as(app, fresh).get('/api/v1/auth/me')).status).toBe(200);
    });

    it('logout-all revokes every session of the user, clears cookies, audits', async () => {
      const web = await webLogin(app, 'emp');
      const token = await bearerLogin(app, 'emp');
      const other = await webLogin(app, 'boss');
      const out = await as(app, web).post('/api/v1/auth/logout-all');
      expect(out.status).toBe(204);
      const cleared = ([] as string[]).concat(out.headers['set-cookie']);
      expect(cleared.some((c) => c.startsWith('wf_session=;'))).toBe(true);
      expect(cleared.some((c) => c.startsWith('wf_csrf=;'))).toBe(true);
      expect((await as(app, web).get('/api/v1/auth/me')).status).toBe(401);
      expect((await http().get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
      expect((await as(app, other).get('/api/v1/auth/me')).status).toBe(200);
      expect(await prisma.session.count({ where: { user: { username: 'emp' }, revokedAt: null } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { action: 'LOGOUT_ALL' } })).toBe(1);
    });
  });

  describe('forced password change', () => {
    it('blocks everything but the allow-listed routes until the password is changed', async () => {
      const u = await createUser({ username: 'fresh', roles: ['EMPLOYEE'] });
      await prisma.user.update({ where: { id: u.userId }, data: { mustChangePassword: true } });
      const res = await http().post('/api/v1/auth/login').send({ username: 'fresh', password: TEST_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.user.mustChangePassword).toBe(true);
      const s = await webLogin(app, 'fresh');
      const token = await bearerLogin(app, 'fresh');

      const me = await as(app, s).get('/api/v1/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.mustChangePassword).toBe(true);
      const blocked = await as(app, s).patch('/api/v1/auth/me/locale').send({ locale: 'en' });
      expect(blocked.status).toBe(403);
      expectErrorEnvelope(blocked.body, 'PASSWORD_CHANGE_REQUIRED');
      expect((await as(app, s).get('/api/v1/notifications')).status).toBe(403);
      expect((await http().get('/api/v1/notifications').set('Authorization', `Bearer ${token}`)).status).toBe(403);

      const wrong = await as(app, s).post('/api/v1/auth/me/password').send({ currentPassword: 'not-it-123', newPassword: 'brand-new-pass-1' });
      expect(wrong.status).toBe(400);
      expectErrorEnvelope(wrong.body, 'INVALID_CURRENT_PASSWORD');
      const reused = await as(app, s).post('/api/v1/auth/me/password').send({ currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD });
      expect(reused.status).toBe(400);
      expectErrorEnvelope(reused.body, 'PASSWORD_REUSED');
      const short = await as(app, s).post('/api/v1/auth/me/password').send({ currentPassword: TEST_PASSWORD, newPassword: 'short' });
      expect(short.status).toBe(400);
      expectErrorEnvelope(short.body, 'VALIDATION_FAILED');

      const ok = await as(app, s).post('/api/v1/auth/me/password').send({ currentPassword: TEST_PASSWORD, newPassword: 'brand-new-pass-1' });
      expect(ok.status).toBe(204);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: u.userId } })).mustChangePassword).toBe(false);
      // The current session keeps working; the other one was revoked.
      expect((await as(app, s).patch('/api/v1/auth/me/locale').send({ locale: 'en' })).status).toBe(200);
      expect((await http().get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
      expect((await login('fresh', 'brand-new-pass-1')).status).toBe(200);
      expect((await login('fresh', TEST_PASSWORD)).status).toBe(401);

      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'PASSWORD_CHANGE', entityId: u.userId } });
      expect(JSON.stringify(audit.after)).not.toMatch(/brand-new-pass-1|test-password-123|argon2/);
      expect(await prisma.auditLog.count({ where: { action: 'PASSWORD_CHANGE_FAILED', entityId: u.userId } })).toBe(1);
    });

    it('counts a wrong current password against the (user, IP) limiter', async () => {
      await createUser({ username: 'guesser', roles: ['EMPLOYEE'] });
      const s = await webLogin(app, 'guesser');
      for (let i = 0; i < 5; i++) {
        expect((await as(app, s).post('/api/v1/auth/me/password').send({ currentPassword: `bad-guess-${i}xx`, newPassword: 'brand-new-pass-1' })).status).toBe(400);
      }
      // The pair is now locked: even the right current password is refused, and so is a new sign-in from this IP.
      expect((await as(app, s).post('/api/v1/auth/me/password').send({ currentPassword: TEST_PASSWORD, newPassword: 'brand-new-pass-1' })).status).toBe(423);
      expect((await login('guesser', TEST_PASSWORD)).status).toBe(423);
    });

    it('an admin/HR-set password sets the flag; nobody changes their own password through PATCH /employees', async () => {
      const hr = await webLogin(app, 'hrperson');
      const created = await as(app, hr).post('/api/v1/employees').send({
        employeeCode: 'H-1', fullName: 'New Hire', username: 'newbie', password: 'initial-pass-1',
      });
      expect(created.status).toBe(201);
      expect((await prisma.user.findUniqueOrThrow({ where: { username: 'newbie' } })).mustChangePassword).toBe(true);

      // Reset an existing user's password: flag set again, all their sessions revoked.
      await prisma.user.update({ where: { username: 'emp' }, data: { mustChangePassword: false } });
      const empSession = await webLogin(app, 'emp');
      const emp = await prisma.employee.findFirstOrThrow({ where: { user: { username: 'emp' } } });
      const reset = await as(app, hr).patch(`/api/v1/employees/${emp.id}`).send({ password: 'reset-by-hr-1' });
      expect(reset.status).toBe(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { username: 'emp' } })).mustChangePassword).toBe(true);
      expect((await as(app, empSession).get('/api/v1/auth/me')).status).toBe(401);
      await prisma.user.update({ where: { username: 'emp' }, data: { mustChangePassword: false, passwordHash: (await prisma.user.findUniqueOrThrow({ where: { username: 'boss' } })).passwordHash } });

      const self = await prisma.employee.findFirstOrThrow({ where: { user: { username: 'hrperson' } } });
      const own = await as(app, hr).patch(`/api/v1/employees/${self.id}`).send({ password: 'my-own-pass-1' });
      expect(own.status).toBe(403);
      expect(own.body.error.message).toMatch(/auth\/me\/password/);
      // Other self-edits still work.
      expect((await as(app, hr).patch(`/api/v1/employees/${self.id}`).send({ jobTitle: 'HR Lead' })).status).toBe(200);
    });
  });

  describe('misc', () => {
    it('rejects absurd page numbers with 400 instead of 500', async () => {
      const s = await webLogin(app, 'boss');
      const n = await as(app, s).get('/api/v1/notifications?page=100001');
      expect(n.status).toBe(400);
      expectErrorEnvelope(n.body, 'VALIDATION_FAILED');
      expect((await as(app, s).get('/api/v1/notifications?page=100000')).status).toBe(200);
      const d = await as(app, s).get('/api/v1/dashboard/live?page=99999999999');
      expect(d.status).toBe(400);
    });

    it('serves Swagger only outside production unless SWAGGER=true', async () => {
      expect(swaggerEnabled({ NODE_ENV: 'development' })).toBe(true);
      expect(swaggerEnabled({ NODE_ENV: 'production' })).toBe(false);
      expect(swaggerEnabled({ NODE_ENV: 'production', SWAGGER: 'true' })).toBe(true);
      let prod: INestApplication | undefined;
      await withEnv({ NODE_ENV: 'production' }, async () => {
        prod = await createAppWith();
      });
      try {
        expect((await request(prod!.getHttpServer()).get('/api/docs-json')).status).toBe(404);
        expect((await request(prod!.getHttpServer()).get('/api/docs')).status).toBe(404);
      } finally {
        await prod!.close();
      }
    });
  });

  describe('seed modes', () => {
    it('plans admin-only (must change password, no office coordinates) by default and demo people only with SEED_DEMO_DATA=true', () => {
      const prod = seedPlan({});
      expect(prod.demo).toBe(false);
      expect(prod.people.map((p) => p.username)).toEqual(['admin']);
      expect(prod.people[0].mustChangePassword).toBe(true);
      expect(prod.office).toBeNull();

      const demo = seedPlan({ SEED_DEMO_DATA: 'true' });
      expect(demo.people.map((p) => p.username)).toEqual(expect.arrayContaining(['admin', 'hr', 'manager', 'dev1', 'design2']));
      expect(demo.people).toHaveLength(9); // admin + hr + manager + 6 employees
      expect(demo.people.every((p) => !p.mustChangePassword)).toBe(true);
      expect(demo.office).toEqual({ latitude: 31.9539, longitude: 35.9106, radiusMeters: 150 });
    });

    it('seeds the database idempotently in both modes', async () => {
      await resetDb();
      await withEnv({ SEED_DEMO_DATA: undefined, SEED_DEFAULT_PASSWORD: 'seed-pass-12345' }, async () => {
        await runSeed();
        await runSeed();
      });
      let users = await prisma.user.findMany({ select: { username: true, mustChangePassword: true } });
      expect(users).toEqual([{ username: 'admin', mustChangePassword: true }]);
      expect(await prisma.location.findMany({ select: { name: true, latitude: true, longitude: true } })).toEqual([{ name: 'Amman HQ', latitude: null, longitude: null }]);
      expect(await prisma.leaveType.count()).toBeGreaterThan(0);

      await withEnv({ SEED_DEMO_DATA: 'true', SEED_DEFAULT_PASSWORD: 'seed-pass-12345' }, async () => {
        await runSeed();
      });
      users = await prisma.user.findMany({ select: { username: true, mustChangePassword: true }, orderBy: { username: 'asc' } });
      expect(users).toHaveLength(9);
      // Existing admin keeps its flag; demo people do not get one.
      expect(users.find((u) => u.username === 'admin')!.mustChangePassword).toBe(true);
      expect(users.filter((u) => u.username !== 'admin').every((u) => !u.mustChangePassword)).toBe(true);
      expect(await prisma.location.findMany({ select: { name: true, latitude: true, longitude: true, radiusMeters: true } }))
        .toEqual([{ name: 'Amman HQ', latitude: 31.9539, longitude: 35.9106, radiusMeters: 150 }]);
      await seedClient.$disconnect();
    });
  });
});

/** createAppWith, but with TRUSTED_PROXIES=loopback so the X-Forwarded-For spoof attempt is actually honoured for req.ip. */
async function withTrustedLoopback<T>(fn: () => Promise<T>): Promise<T> {
  process.env.TRUSTED_PROXIES = 'loopback';
  try { return await fn(); } finally { delete process.env.TRUSTED_PROXIES; }
}
