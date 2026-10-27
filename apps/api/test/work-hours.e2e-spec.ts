// Effective-dated company work hours (work_hours_rules): endpoints, validation, permissions and per-day effect.
import type { INestApplication } from '@nestjs/common';
import { expectErrorEnvelope } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';
import { auditActions, DAY, seedPeople } from './request-fixtures';

let app: INestApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

let people: Awaited<ReturnType<typeof seedPeople>>;
beforeEach(async () => {
  await resetDb();
  // Base rule from 2000-01-01: 8 h without a break allowance (as the company ran before the change).
  people = await seedPeople(app);
});

const NINE = { effectiveFrom: '2026-10-28', dailyRequiredMinutes: 540, includedBreakMinutes: 60 };

describe('work hours rules', () => {
  it('lists, adds, replaces and deletes rules; the earliest cannot be deleted', async () => {
    const list = await people.http.admin.get('/api/v1/settings/work-hours');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([expect.objectContaining({ effectiveFrom: '2000-01-01', dailyRequiredMinutes: DAY, includedBreakMinutes: 0 })]);
    const baseId: string = list.body[0].id;

    const created = await people.http.admin.post('/api/v1/settings/work-hours').send(NINE);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ ...NINE, id: expect.any(String), createdAt: expect.any(String) });

    // Same date: replaced in place, not added.
    const replaced = await people.http.admin.post('/api/v1/settings/work-hours').send({ ...NINE, includedBreakMinutes: 45 });
    expect(replaced.status).toBe(201);
    expect(replaced.body).toMatchObject({ id: created.body.id, includedBreakMinutes: 45 });
    const after = await people.http.admin.get('/api/v1/settings/work-hours');
    expect(after.body.map((r: { effectiveFrom: string }) => r.effectiveFrom)).toEqual(['2000-01-01', '2026-10-28']);
    expect(await auditActions(created.body.id)).toEqual(['WORK_HOURS_RULE_CREATE', 'WORK_HOURS_RULE_UPDATE']);

    const earliest = await people.http.admin.delete(`/api/v1/settings/work-hours/${baseId}`);
    expect(earliest.status).toBe(409);
    expectErrorEnvelope(earliest.body, 'CONFLICT');

    expect((await people.http.admin.delete(`/api/v1/settings/work-hours/${created.body.id}`)).status).toBe(204);
    expect(await auditActions(created.body.id)).toEqual(['WORK_HOURS_RULE_CREATE', 'WORK_HOURS_RULE_UPDATE', 'WORK_HOURS_RULE_DELETE']);
    expect((await people.http.admin.delete(`/api/v1/settings/work-hours/${created.body.id}`)).status).toBe(404);
    expect(await prisma.workHoursRule.count()).toBe(1);
  });

  it('rejects invalid rules', async () => {
    const bad = [
      { ...NINE, dailyRequiredMinutes: 20 },
      { ...NINE, dailyRequiredMinutes: 1441 },
      { ...NINE, includedBreakMinutes: 241 },
      { ...NINE, includedBreakMinutes: -1 },
      { ...NINE, dailyRequiredMinutes: 60, includedBreakMinutes: 90 },
      { ...NINE, dailyRequiredMinutes: 540.5 },
      { ...NINE, effectiveFrom: '2026-02-30' },
      { ...NINE, effectiveFrom: '28/10/2026' },
      { dailyRequiredMinutes: 540, includedBreakMinutes: 60 },
    ];
    for (const body of bad) {
      const res = await people.http.admin.post('/api/v1/settings/work-hours').send(body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
      expectErrorEnvelope(res.body, 'VALIDATION_FAILED');
    }
    expect(await prisma.workHoursRule.count()).toBe(1);
  });

  it('needs settings.manage to change rules; employee readers see the current hours', async () => {
    const { emp, mgr, hr } = people.http;
    expect((await emp.get('/api/v1/settings/work-hours')).status).toBe(403);
    expect((await emp.post('/api/v1/settings/work-hours').send(NINE)).status).toBe(403);
    expect((await mgr.post('/api/v1/settings/work-hours').send(NINE)).status).toBe(403);
    expect((await hr.post('/api/v1/settings/work-hours').send(NINE)).status).toBe(403);
    const base = await prisma.workHoursRule.findFirstOrThrow();
    expect((await mgr.delete(`/api/v1/settings/work-hours/${base.id}`)).status).toBe(403);
    expect((await emp.get('/api/v1/settings/work-hours/current')).status).toBe(403);

    expect((await hr.get('/api/v1/settings/work-hours/current')).status).toBe(200);
    const current = await mgr.get('/api/v1/settings/work-hours/current');
    expect(current.status).toBe(200);
    expect(current.body).toEqual({ effectiveFrom: '2000-01-01', dailyRequiredMinutes: DAY, includedBreakMinutes: 0 });
    // A rule starting in the future does not change today's hours.
    await people.http.admin.post('/api/v1/settings/work-hours').send({ ...NINE, effectiveFrom: '2999-01-01' });
    expect((await mgr.get('/api/v1/settings/work-hours/current')).body).toMatchObject({ effectiveFrom: '2000-01-01' });
  });

  it('days before the effective date keep the earlier hours', async () => {
    expect((await people.http.admin.post('/api/v1/settings/work-hours').send(NINE)).status).toBe(201);
    // Tuesday and Wednesday: workdays of the built-in Sun-Thu schedule.
    const res = await people.http.emp.get('/api/v1/attendance/me/days').query({ from: '2026-10-27', to: '2026-10-28' });
    expect(res.status).toBe(200);
    const byDate = new Map(res.body.map((d: { workDate: string }) => [d.workDate, d]));
    expect(byDate.get('2026-10-27')).toMatchObject({ requiredMinutes: DAY, includedBreakMinutes: 0 });
    expect(byDate.get('2026-10-28')).toMatchObject({ requiredMinutes: 540, includedBreakMinutes: 60 });
  });
});
