import type { INestApplication } from '@nestjs/common';
import { PORTAL_KEYS } from '@workforce/shared';
import request from 'supertest';
import { addDays } from '../src/common/time';
import { SettingsService } from '../src/modules/settings/settings.service';
import { expectErrorEnvelope } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';
import { futureSunday, seedPeople, seedRequestCatalog, today, workdayFrom } from './request-fixtures';

let app: INestApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

let catalog: Awaited<ReturnType<typeof seedRequestCatalog>>;
let people: Awaited<ReturnType<typeof seedPeople>>;
beforeEach(async () => {
  await resetDb();
  // TRUNCATE bypasses the service, so drop its short-lived settings cache as well.
  app.get(SettingsService).invalidate();
  catalog = await seedRequestCatalog();
  people = await seedPeople(app);
});

const SETTING = '/api/v1/settings/portal.visibility';
const ALL_VISIBLE = Object.fromEntries(PORTAL_KEYS.map((k) => [k, true]));

/** Saves portal visibility as the SUPER_ADMIN (settings.manage). */
async function hide(value: Record<string, boolean>) {
  const res = await people.http.admin.patch(SETTING).send({ value });
  expect(res.status).toBe(200);
  return res;
}

function expectPortalDisabled(res: request.Response, key: string) {
  expect(res.status).toBe(403);
  expectErrorEnvelope(res.body, 'FORBIDDEN');
  expect(res.body.error.details).toEqual({ reason: 'PORTAL_DISABLED', key });
}

const fullDays = (startDate: string, endDate: string) =>
  ({ leaveTypeId: catalog.annual.id, mode: 'FULL_DAY', startDate, endDate, reason: 'Family visit' });

describe('employee-portal visibility', () => {
  it('/auth/me and GET /settings expose all 14 keys as visible by default', async () => {
    expect(PORTAL_KEYS).toHaveLength(14);
    const me = await people.http.emp.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.portal).toEqual(ALL_VISIBLE);

    const list = await people.http.admin.get('/api/v1/settings');
    expect(list.body.find((s: { key: string }) => s.key === 'portal.visibility')).toMatchObject({ value: ALL_VISIBLE });
  });

  it('hiding Overtime blocks new overtime requests but keeps reads working', async () => {
    const day = workdayFrom(addDays(today(), 3));
    const before = await people.http.emp.post('/api/v1/overtime/requests').send({ workDate: day, minutes: 60, reason: 'Release' });
    expect(before.status).toBe(201);

    const saved = await hide({ overtime: false });
    expect(saved.body).toMatchObject({ key: 'portal.visibility', value: { ...ALL_VISIBLE, overtime: false } });

    const blocked = await people.http.emp2.post('/api/v1/overtime/requests').send({ workDate: day, minutes: 60, reason: 'Release' });
    expectPortalDisabled(blocked, 'overtime');
    // Rejected before validation: an invalid body gets the same answer.
    expectPortalDisabled(await people.http.emp2.post('/api/v1/overtime/requests').send({}), 'overtime');

    const me = await people.http.emp.get('/api/v1/auth/me');
    expect(me.body.portal).toMatchObject({ overtime: false, 'overtime.requests': true, leave: true });
    expect((await people.http.emp.get('/api/v1/overtime/me/requests')).status).toBe(200);
    expect((await people.http.emp.get('/api/v1/leave/me/balances')).status).toBe(200);
    // Other request kinds are untouched.
    const sun = futureSunday();
    expect((await people.http.emp.post('/api/v1/leave/requests/preview').send(fullDays(sun, addDays(sun, 1)))).status).toBe(200);
    // Managers still decide on existing requests.
    expect((await people.http.mgr.post(`/api/v1/approvals/overtime/${before.body.id}/approve`).send({})).status).toBe(200);
  });

  it('hiding a section ("leave.requests") blocks leave requests and previews, while balances stay readable', async () => {
    await hide({ 'leave.requests': false });
    const sun = futureSunday();
    expectPortalDisabled(await people.http.emp.post('/api/v1/leave/requests').send(fullDays(sun, addDays(sun, 1))), 'leave.requests');
    expectPortalDisabled(await people.http.emp.post('/api/v1/leave/requests/preview').send(fullDays(sun, addDays(sun, 1))), 'leave.requests');
    expect((await people.http.emp.get('/api/v1/leave/me/balances')).status).toBe(200);
    expect((await people.http.emp.get('/api/v1/leave/me/requests')).status).toBe(200);

    // Hiding the whole page reports the page key.
    await hide({ leave: false });
    expectPortalDisabled(await people.http.emp.post('/api/v1/leave/requests').send(fullDays(sun, addDays(sun, 1))), 'leave');

    // Turning it back on lets requests through again.
    await hide({ leave: true, 'leave.requests': true });
    expect((await people.http.emp.post('/api/v1/leave/requests').send(fullDays(sun, addDays(sun, 1)))).status).toBe(201);
  });

  it('hiding Corrections blocks correction requests (and guards still run first)', async () => {
    // Visible: the request reaches validation.
    expect((await people.http.emp.post('/api/v1/corrections/requests').send({})).status).toBe(400);
    await hide({ corrections: false });
    expectPortalDisabled(await people.http.emp.post('/api/v1/corrections/requests').send({}), 'corrections');
    // Unauthenticated callers still get 401, not the portal message.
    expect((await request(app.getHttpServer()).post('/api/v1/corrections/requests').send({})).status).toBe(401);
  });

  it('rejects locked keys, unknown keys and non-boolean values', async () => {
    for (const value of [{ home: false }, { unknown: true }, { notifications: false }, { overtime: 'no' }, ['overtime'], null, 'off']) {
      const res = await people.http.admin.patch(SETTING).send({ value });
      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'VALIDATION_FAILED');
    }
    // Locked keys may be sent as true.
    expect((await people.http.admin.patch(SETTING).send({ value: { home: true, attendance: true } })).status).toBe(200);
  });

  it('rejects an empty object (it would silently reset every toggle)', async () => {
    await hide({ overtime: false });
    const res = await people.http.admin.patch(SETTING).send({ value: {} });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'VALIDATION_FAILED');
    expect(res.body.error.message).toMatch(/at least one/);
    // Unknown keys are still rejected, and the saved choice is unchanged.
    expect((await people.http.admin.patch(SETTING).send({ value: { nope: true } })).status).toBe(400);
    const me = await people.http.emp.get('/api/v1/auth/me');
    expect(me.body.portal.overtime).toBe(false);
  });

  it('hiding "leave.documents" (or Leave) blocks document uploads by employees, not by HR', async () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
    const day = futureSunday();
    const created = await people.http.emp.post('/api/v1/leave/requests').send(fullDays(day, day));
    expect(created.status).toBe(201);
    const url = `/api/v1/leave/requests/${created.body.id}/documents`;
    expect((await people.http.emp.post(url).attach('file', PNG, { filename: 'a.png' })).status).toBe(201);

    await hide({ 'leave.documents': false });
    expectPortalDisabled(await people.http.emp.post(url).attach('file', PNG, { filename: 'b.png' }), 'leave.documents');
    // HR works from the administration pages, which follow roles.
    expect((await people.http.hr.post(url).attach('file', PNG, { filename: 'hr.png' })).status).toBe(201);
    // Leave requests themselves are still allowed.
    const sun = futureSunday(14);
    expect((await people.http.emp.post('/api/v1/leave/requests/preview').send(fullDays(sun, sun))).status).toBe(200);

    await hide({ leave: false });
    expectPortalDisabled(await people.http.emp.post(url).attach('file', PNG, { filename: 'c.png' }), 'leave');
    expect(await prisma.leaveAttachment.count({ where: { leaveRequestId: created.body.id } })).toBe(2);
  });

  it('only settings.manage can change it', async () => {
    expect((await people.http.emp.patch(SETTING).send({ value: { overtime: false } })).status).toBe(403);
    expect((await people.http.mgr.patch(SETTING).send({ value: { overtime: false } })).status).toBe(403);
    const me = await people.http.emp.get('/api/v1/auth/me');
    expect(me.body.portal.overtime).toBe(true);
  });

  it('audits each save as SETTING_UPDATE with full before/after objects', async () => {
    await hide({ overtime: false });
    await hide({ overtime: false, 'leave.documents': false });
    const rows = await prisma.auditLog.findMany({
      where: { action: 'SETTING_UPDATE', entityType: 'SystemSetting', entityId: 'portal.visibility' },
      orderBy: { seq: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].actorUserId).toBe(people.users.admin.userId);
    expect(rows[0].before).toEqual({ value: ALL_VISIBLE });
    expect(rows[0].after).toEqual({ value: { ...ALL_VISIBLE, overtime: false } });
    expect(rows[1].before).toEqual({ value: { ...ALL_VISIBLE, overtime: false } });
    expect(rows[1].after).toEqual({ value: { ...ALL_VISIBLE, overtime: false, 'leave.documents': false } });
  });
});
