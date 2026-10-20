import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { as, bearerLogin, createUser, expectErrorEnvelope, TEST_PASSWORD, webLogin } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

describe('auth (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await resetDb();
    app = await createTestApp();
    await createUser({ username: 'alice', roles: ['EMPLOYEE'] });
    await createUser({ username: 'locky', roles: ['EMPLOYEE'] });
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('logs in a web client: session + CSRF cookies, csrfToken in body, no bearer token', async () => {
    const res = await http().post('/api/v1/auth/login').send({ username: 'Alice', password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: 'alice', roles: ['EMPLOYEE'] });
    expect(res.body.user.permissions).toContain('attendance.self');
    expect(typeof res.body.csrfToken).toBe('string');
    expect(res.body.accessToken).toBeUndefined();
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const cookies = ([] as string[]).concat(res.headers['set-cookie']);
    const session = cookies.find((c) => c.startsWith('wf_session='))!;
    const csrf = cookies.find((c) => c.startsWith('wf_csrf='))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Strict/i);
    expect(session).toMatch(/Path=\//);
    expect(session).not.toMatch(/Secure/); // plain HTTP in tests
    expect(csrf).not.toMatch(/HttpOnly/i);
    expect(csrf).toMatch(/SameSite=Strict/i);
    expect(decodeURIComponent(csrf.split(';')[0].split('=')[1])).toBe(res.body.csrfToken);
    // Browser-session cookies: no Expires / Max-Age (server-side expiry still applies).
    expect(session).not.toMatch(/Expires=|Max-Age=/i);
    expect(csrf).not.toMatch(/Expires=|Max-Age=/i);

    // Only a hash of the token is stored.
    const token = session.split(';')[0].split('=')[1];
    const stored = await prisma.session.findMany({ where: { user: { username: 'alice' } } });
    expect(stored.some((s) => s.tokenHash === token)).toBe(false);
    expect(stored.every((s) => /^[0-9a-f]{64}$/.test(s.tokenHash))).toBe(true);

    const me = await http().get('/api/v1/auth/me').set('Cookie', session.split(';')[0]);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe('alice');
  });

  it('rejects bad credentials with a generic error', async () => {
    const wrong = await http().post('/api/v1/auth/login').send({ username: 'alice', password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expectErrorEnvelope(wrong.body, 'INVALID_CREDENTIALS');
    const unknown = await http().post('/api/v1/auth/login').send({ username: 'nobody', password: 'not-the-password' });
    expect(unknown.status).toBe(401);
    expectErrorEnvelope(unknown.body, 'INVALID_CREDENTIALS');
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('locks the (username, IP) pair after the configured number of failures; only the right password reveals it', async () => {
    const statuses: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await http().post('/api/v1/auth/login').send({ username: 'locky', password: 'wrong-password' });
      statuses.push(r.body.error.code);
    }
    // Wrong passwords never reveal the lock.
    expect(statuses).toEqual(Array(6).fill('INVALID_CREDENTIALS'));
    const correct = await http().post('/api/v1/auth/login').send({ username: 'locky', password: TEST_PASSWORD });
    expect(correct.status).toBe(423);
    expectErrorEnvelope(correct.body, 'ACCOUNT_LOCKED');
    expect(new Date(correct.body.error.details.lockedUntil).getTime()).toBeGreaterThan(Date.now());
    // The per-user database counter is a backstop with a higher threshold: not locked yet.
    const user = await prisma.user.findUniqueOrThrow({ where: { username: 'locky' } });
    expect(user.failedLoginCount).toBe(6);
    expect(user.lockedUntil).toBeNull();
  });

  it('supports bearer (MOBILE) sessions without CSRF and without cookies', async () => {
    const res = await http().post('/api/v1/auth/login').send({ username: 'alice', password: TEST_PASSWORD, client: 'MOBILE' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body.csrfToken).toBeUndefined();
    const token = res.body.accessToken as string;
    const patch = await http().patch('/api/v1/auth/me/locale').set('Authorization', `Bearer ${token}`).send({ locale: 'en' });
    expect(patch.status).toBe(200);
    expect(patch.body.locale).toBe('en');
    const bad = await http().get('/api/v1/auth/me').set('Authorization', 'Bearer nope');
    expect(bad.status).toBe(401);
    expectErrorEnvelope(bad.body, 'UNAUTHENTICATED');
  });

  it('requires a matching X-CSRF-Token for cookie-authenticated writes', async () => {
    const s = await webLogin(app, 'alice');
    const none = await http().patch('/api/v1/auth/me/locale').set('Cookie', s.cookie).send({ locale: 'ar' });
    expect(none.status).toBe(403);
    expectErrorEnvelope(none.body, 'CSRF_FAILED');
    const wrong = await http().patch('/api/v1/auth/me/locale').set('Cookie', s.cookie).set('X-CSRF-Token', 'forged').send({ locale: 'ar' });
    expect(wrong.status).toBe(403);
    expectErrorEnvelope(wrong.body, 'CSRF_FAILED');
    const ok = await as(app, s).patch('/api/v1/auth/me/locale').send({ locale: 'ar' });
    expect(ok.status).toBe(200);
    expect(ok.body.locale).toBe('ar');
  });

  it('logout revokes the session and clears cookies', async () => {
    const s = await webLogin(app, 'alice');
    const out = await as(app, s).post('/api/v1/auth/logout');
    expect(out.status).toBe(204);
    const cleared = ([] as string[]).concat(out.headers['set-cookie']);
    expect(cleared.some((c) => c.startsWith('wf_session=;'))).toBe(true);
    const me = await http().get('/api/v1/auth/me').set('Cookie', s.cookie);
    expect(me.status).toBe(401);
  });

  it('refuses inactive users and kills their sessions', async () => {
    const u = await createUser({ username: 'gone', roles: ['EMPLOYEE'] });
    const token = await bearerLogin(app, 'gone');
    await prisma.user.update({ where: { id: u.userId }, data: { isActive: false } });
    expect((await http().get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    const login = await http().post('/api/v1/auth/login').send({ username: 'gone', password: TEST_PASSWORD });
    expect(login.status).toBe(401);
    expectErrorEnvelope(login.body, 'INVALID_CREDENTIALS');
  });

  it('returns the error envelope for unauthenticated, validation and unknown-route errors', async () => {
    const unauth = await http().get('/api/v1/auth/me');
    expect(unauth.status).toBe(401);
    expectErrorEnvelope(unauth.body, 'UNAUTHENTICATED');
    expect(unauth.body.path).toBe('/api/v1/auth/me');

    const invalid = await http().post('/api/v1/auth/login').send({ username: 'alice', password: 'x', extra: 1, client: 'TV' });
    expect(invalid.status).toBe(400);
    expectErrorEnvelope(invalid.body, 'VALIDATION_FAILED');
    const fields = (invalid.body.error.details as { field: string }[]).map((d) => d.field).sort();
    expect(fields).toEqual(['client', 'extra']);

    const malformed = await http().post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{"username":');
    expect(malformed.status).toBe(400);
    expectErrorEnvelope(malformed.body, 'VALIDATION_FAILED');

    const missing = await http().get('/api/v1/definitely-not-a-route');
    expect(missing.status).toBe(404);
    expectErrorEnvelope(missing.body, 'NOT_FOUND');
  });

  it('serves health, security headers and the OpenAPI document', async () => {
    const health = await http().get('/api/v1/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: 'ok', database: 'up' });
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['x-frame-options']).toBe('DENY');
    expect(health.headers['referrer-policy']).toBe('no-referrer');
    expect(health.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(health.headers['x-powered-by']).toBeUndefined();

    const docs = await http().get('/api/docs-json');
    expect(docs.status).toBe(200);
    expect(docs.body.paths['/api/v1/auth/login']).toBeDefined();
    expect(docs.body.paths['/api/v1/employees']).toBeDefined();
    expect(Object.keys(docs.body.components.securitySchemes).sort()).toEqual(['bearer', 'cookie']);
  });

  it('hides demo login unless DEMO_MODE=true, and audits demo logins', async () => {
    expect((await http().get('/api/v1/auth/demo/accounts')).status).toBe(404);
    expect((await http().post('/api/v1/auth/demo/login').send({ username: 'alice' })).status).toBe(404);
    process.env.DEMO_MODE = 'true';
    try {
      const accounts = await http().get('/api/v1/auth/demo/accounts');
      expect(accounts.status).toBe(200);
      expect(accounts.body).toEqual(expect.arrayContaining([expect.objectContaining({ username: 'alice', roles: ['EMPLOYEE'] })]));
      expect(accounts.body.some((a: { username: string }) => a.username === 'gone')).toBe(false);
      const login = await http().post('/api/v1/auth/demo/login').send({ username: 'alice' });
      expect(login.status).toBe(200);
      expect(login.body.csrfToken).toEqual(expect.any(String));
      expect(await prisma.auditLog.count({ where: { action: 'DEMO_LOGIN' } })).toBe(1);
    } finally {
      process.env.DEMO_MODE = 'false';
    }
  });

  it('rate-limits login attempts per IP', async () => {
    process.env.RATE_LIMIT_IN_TESTS = 'true';
    process.env.RATE_LIMIT_LOGIN_PER_MINUTE = '3';
    try {
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        codes.push((await http().post('/api/v1/auth/login').send({ username: 'nobody', password: 'irrelevant' })).status);
      }
      expect(codes).toEqual([401, 401, 401]);
      const limited = await http().post('/api/v1/auth/login').send({ username: 'nobody', password: 'irrelevant' });
      expect(limited.status).toBe(429);
      expectErrorEnvelope(limited.body, 'RATE_LIMITED');
    } finally {
      delete process.env.RATE_LIMIT_IN_TESTS;
      delete process.env.RATE_LIMIT_LOGIN_PER_MINUTE;
    }
  });
});
