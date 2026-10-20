import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, prisma } from './helpers';

describe('static web serving (e2e)', () => {
  let app: INestApplication;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wf-web-'));
    writeFileSync(join(dir, 'index.html'), '<html>home</html>');
    writeFileSync(join(dir, '404.html'), '<html>not found page</html>');
    mkdirSync(join(dir, 'employees'));
    writeFileSync(join(dir, 'employees', 'index.html'), '<html>employees</html>');
    mkdirSync(join(dir, '_next', 'static'), { recursive: true });
    writeFileSync(join(dir, '_next', 'static', 'app.js'), 'console.log(1)');
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    process.env.WEB_DIST = dir;
    app = await createTestApp();
  });
  afterAll(async () => {
    delete process.env.WEB_DIST;
    await app.close();
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  const http = () => request(app.getHttpServer());

  it('serves index.html for / and directory routes with or without a trailing slash', async () => {
    expect((await http().get('/')).text).toContain('home');
    expect((await http().get('/employees/')).text).toContain('employees');
    expect((await http().get('/employees')).text).toContain('employees');
  });

  it('serves static assets with long-lived caching', async () => {
    const res = await http().get('/_next/static/app.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('falls back to 404.html for unknown pages but never for /api', async () => {
    const page = await http().get('/no/such/page');
    expect(page.status).toBe(404);
    expect(page.text).toContain('not found page');
    const api = await http().get('/api/v1/nope');
    expect(api.status).toBe(404);
    expect(api.body.error.code).toBe('NOT_FOUND');
  });

  it('does not serve dotfiles or escape the web root', async () => {
    expect((await http().get('/.env')).text).not.toContain('SECRET');
    expect((await http().get('/..%2f..%2fpackage.json')).text).not.toContain('"name"');
  });
});
