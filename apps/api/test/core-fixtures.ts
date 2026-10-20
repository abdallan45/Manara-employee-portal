// Fixtures for the auth, employees, departments, audit and settings tests.
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { hashPassword } from '../src/modules/auth/password';
import { prisma } from './helpers';

export const TEST_PASSWORD = 'test-password-123';
let cachedHash: Promise<string> | null = null;
const passwordHash = () => (cachedHash ??= hashPassword(TEST_PASSWORD));

export async function createDepartment(code: string, name = code) {
  return prisma.department.create({ data: { code, name } });
}

export interface FixtureUser { userId: string; employeeId: string; username: string }

/** Creates an employee + user with the given roles. `manages` scopes DEPARTMENT_MANAGER to those departments. */
export async function createUser(opts: {
  username: string; roles: string[]; departmentId?: string | null; manages?: string[]; code?: string;
}): Promise<FixtureUser> {
  const roles = await prisma.role.findMany({ where: { key: { in: opts.roles } } });
  const grants = roles.flatMap((r): { roleId: string; departmentId: string | null }[] =>
    r.key === 'DEPARTMENT_MANAGER' && opts.manages?.length
      ? opts.manages.map((departmentId) => ({ roleId: r.id, departmentId }))
      : [{ roleId: r.id, departmentId: null }]);
  const employee = await prisma.employee.create({
    data: {
      employeeCode: opts.code ?? `T-${opts.username.toUpperCase()}`,
      fullName: `Test ${opts.username}`,
      departmentId: opts.departmentId ?? null,
      user: { create: { username: opts.username, passwordHash: await passwordHash(), roles: { create: grants } } },
    },
    include: { user: true },
  });
  return { userId: employee.user!.id, employeeId: employee.id, username: opts.username };
}

export interface WebSession { cookie: string; csrf: string }

/** Logs in as a WEB client; returns the Cookie header value and the CSRF token. */
export async function webLogin(app: INestApplication, username: string, password = TEST_PASSWORD): Promise<WebSession> {
  const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  return { cookie, csrf: res.body.csrfToken };
}

export async function bearerLogin(app: INestApplication, username: string, password = TEST_PASSWORD): Promise<string> {
  const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ username, password, client: 'MOBILE' });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

/** supertest helpers that attach a web session (cookie + CSRF header on writes). */
export function as(app: INestApplication, s: WebSession) {
  const server = app.getHttpServer();
  return {
    get: (url: string) => request(server).get(url).set('Cookie', s.cookie),
    post: (url: string) => request(server).post(url).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf),
    patch: (url: string) => request(server).patch(url).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf),
    delete: (url: string) => request(server).delete(url).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf),
  };
}

export function expectErrorEnvelope(body: unknown, code: string): void {
  expect(body).toEqual({
    error: expect.objectContaining({ code, message: expect.any(String) }),
    statusCode: expect.any(Number),
    path: expect.any(String),
    timestamp: expect.any(String),
  });
}
