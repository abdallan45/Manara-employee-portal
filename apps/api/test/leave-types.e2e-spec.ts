import type { INestApplication } from '@nestjs/common';
import { expectErrorEnvelope } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';
import { auditActions, DAY, futureSunday, seedPeople, seedRequestCatalog, today } from './request-fixtures';

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
  catalog = await seedRequestCatalog();
  people = await seedPeople(app);
});

const year = () => Number(today().slice(0, 4));
const codes = (body: { code: string }[]) => body.map((t) => t.code);
const balanceCodes = (body: { leaveType: { code: string } }[]) => body.map((b) => b.leaveType.code);

const marriage = {
  code: 'MARRIAGE', name: 'Marriage leave', nameAr: 'إجازة زواج', unit: 'DAY', accrual: 'YEARLY',
  annualEntitlementMinutes: 3 * DAY, approvalSteps: ['MANAGER', 'HR_ADMIN'],
};

describe('leave type configuration', () => {
  it('needs settings.manage to create or edit (HR, managers and employees are refused)', async () => {
    for (const http of [people.http.hr, people.http.mgr, people.http.emp]) {
      expect((await http.post('/api/v1/leave/types').send(marriage)).status).toBe(403);
      expect((await http.patch(`/api/v1/leave/types/${catalog.annual.id}`).send({ name: 'X' })).status).toBe(403);
    }
    expect(await prisma.leaveType.count({ where: { code: 'MARRIAGE' } })).toBe(0);
  });

  it('creates a type with defaults, audits it, and the new type opens a balance', async () => {
    const res = await people.http.admin.post('/api/v1/leave/types').send(marriage);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      code: 'MARRIAGE', name: 'Marriage leave', nameAr: 'إجازة زواج', isPaid: true, unit: 'DAY', accrual: 'YEARLY',
      annualEntitlementMinutes: 3 * DAY, carryoverMaxMinutes: 0, requiresAttachment: false, approvalSteps: ['MANAGER', 'HR_ADMIN'],
      isSensitive: false, isActive: true, tracksBalance: true,
    });
    expect(await auditActions(res.body.id)).toEqual(['LEAVE_TYPE_CREATE']);

    const types = await people.http.emp.get('/api/v1/leave/types');
    expect(codes(types.body)).toContain('MARRIAGE');
    const bal = await people.http.emp.get(`/api/v1/leave/me/balances?year=${year()}`);
    expect(bal.body.find((b: { leaveType: { code: string } }) => b.leaveType.code === 'MARRIAGE')).toBeDefined();
  });

  it('validates codes, ranges and accrual consistency; duplicate codes conflict', async () => {
    const admin = people.http.admin;
    const lower = await admin.post('/api/v1/leave/types').send({ ...marriage, code: 'marriage' });
    expect(lower.status).toBe(400);
    expectErrorEnvelope(lower.body, 'VALIDATION_FAILED');
    expect((await admin.post('/api/v1/leave/types').send({ ...marriage, unit: 'WEEK' })).status).toBe(400);
    expect((await admin.post('/api/v1/leave/types').send({ ...marriage, approvalLevels: 2 })).status).toBe(400); // replaced by approvalSteps
    expect((await admin.post('/api/v1/leave/types').send({ ...marriage, annualEntitlementMinutes: -1 })).status).toBe(400);

    const inconsistent = await admin.post('/api/v1/leave/types').send({ ...marriage, accrual: 'NONE' });
    expect(inconsistent.status).toBe(400);
    expect(inconsistent.body.error.details).toEqual([expect.objectContaining({ field: 'annualEntitlementMinutes' })]);

    const dup = await admin.post('/api/v1/leave/types').send({ ...marriage, code: 'ANNUAL' });
    expect(dup.status).toBe(409);
    expectErrorEnvelope(dup.body, 'CONFLICT');

    // Updates are checked against the stored values: ANNUAL has an entitlement, so it cannot become NONE alone.
    const toNone = await admin.patch(`/api/v1/leave/types/${catalog.annual.id}`).send({ accrual: 'NONE' });
    expect(toNone.status).toBe(400);
    const ok = await admin.patch(`/api/v1/leave/types/${catalog.annual.id}`).send({ accrual: 'NONE', annualEntitlementMinutes: 0, carryoverMaxMinutes: 0 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ accrual: 'NONE', tracksBalance: false });

    expect((await admin.patch(`/api/v1/leave/types/${catalog.annual.id}`).send({ code: 'OTHER' })).status).toBe(400); // code is fixed
    const missing = await admin.patch('/api/v1/leave/types/00000000-0000-4000-8000-000000000000').send({ name: 'X' });
    expect(missing.status).toBe(404);
  });

  it('approval chains: MANAGER or existing roles, 1 to 4 steps; the default is the manager alone', async () => {
    const admin = people.http.admin;
    const noChain = { ...marriage, approvalSteps: undefined };
    const plain = await admin.post('/api/v1/leave/types').send({ ...noChain, code: 'PLAIN' });
    expect(plain.body.approvalSteps).toEqual(['MANAGER']);

    for (const approvalSteps of [[], ['MANAGER', 'HR_ADMIN', 'GENERAL_MANAGER', 'HR_ADMIN', 'MANAGER'], ['NO_SUCH_ROLE'], ['ANY_APPROVER'], ['DIRECT'], [3]]) {
      const res = await admin.post('/api/v1/leave/types').send({ ...marriage, approvalSteps });
      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'VALIDATION_FAILED');
    }
    const unknown = await admin.patch(`/api/v1/leave/types/${catalog.annual.id}`).send({ approvalSteps: ['MANAGER', 'CFO'] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details).toEqual([expect.objectContaining({ field: 'approvalSteps' })]);

    const chain = ['MANAGER', 'HR_ADMIN', 'GENERAL_MANAGER'];
    const ok = await admin.patch(`/api/v1/leave/types/${catalog.annual.id}`).send({ approvalSteps: chain });
    expect(ok.status).toBe(200);
    expect(ok.body.approvalSteps).toEqual(chain);
    const audit = await prisma.auditLog.findFirst({ where: { entityId: catalog.annual.id, action: 'LEAVE_TYPE_UPDATE' } });
    expect(audit?.before).toMatchObject({ approvalSteps: ['MANAGER'] });
    expect(audit?.after).toMatchObject({ approvalSteps: chain });
  });

  it('updates are audited with before/after; posted ledger rows are not rewritten', async () => {
    const before = await people.http.emp.get(`/api/v1/leave/me/balances?year=${year()}`);
    const annualBefore = before.body.find((b: { leaveType: { code: string } }) => b.leaveType.code === 'ANNUAL');
    expect(annualBefore.accrued).toBe(14 * DAY);

    const res = await people.http.admin.patch(`/api/v1/leave/types/${catalog.annual.id}`).send({ annualEntitlementMinutes: 21 * DAY, nameAr: '  ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ annualEntitlementMinutes: 21 * DAY, nameAr: null, code: 'ANNUAL' });
    const audit = await prisma.auditLog.findFirst({ where: { entityId: catalog.annual.id, action: 'LEAVE_TYPE_UPDATE' } });
    expect(audit?.before).toMatchObject({ annualEntitlementMinutes: 14 * DAY });
    expect(audit?.after).toMatchObject({ annualEntitlementMinutes: 21 * DAY });

    // The year was already opened with 14 days; HR adjusts the difference through the ledger.
    const after = await people.http.emp.get(`/api/v1/leave/me/balances?year=${year()}`);
    expect(after.body.find((b: { leaveType: { code: string } }) => b.leaveType.code === 'ANNUAL').accrued).toBe(14 * DAY);
    // A year opened afterwards uses the new entitlement.
    const emp2 = await people.http.emp2.get(`/api/v1/leave/me/balances?year=${year()}`);
    expect(emp2.body.find((b: { leaveType: { code: string } }) => b.leaveType.code === 'ANNUAL').accrued).toBe(21 * DAY);
  });

  it('deactivation hides the type from requests and balances; admins can still list and reactivate it', async () => {
    const res = await people.http.admin.patch(`/api/v1/leave/types/${catalog.twoLevel.id}`).send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);

    expect(codes((await people.http.emp.get('/api/v1/leave/types')).body)).not.toContain('STUDY');
    // includeInactive is ignored without settings.manage.
    expect(codes((await people.http.hr.get('/api/v1/leave/types?includeInactive=true')).body)).not.toContain('STUDY');
    const all = await people.http.admin.get('/api/v1/leave/types?includeInactive=true');
    expect(all.body.find((t: { code: string }) => t.code === 'STUDY')).toMatchObject({ isActive: false });
    expect(balanceCodes((await people.http.emp.get('/api/v1/leave/me/balances')).body)).not.toContain('STUDY');

    const sun = futureSunday();
    const req = await people.http.emp.post('/api/v1/leave/requests').send({ leaveTypeId: catalog.twoLevel.id, mode: 'FULL_DAY', startDate: sun, endDate: sun, reason: 'Exam' });
    expect(req.status).toBe(409);
    expectErrorEnvelope(req.body, 'LEAVE_TYPE_INACTIVE');

    await people.http.admin.patch(`/api/v1/leave/types/${catalog.twoLevel.id}`).send({ isActive: true });
    expect(await auditActions(catalog.twoLevel.id)).toEqual(['LEAVE_TYPE_DEACTIVATE', 'LEAVE_TYPE_REACTIVATE']);
    expect(codes((await people.http.emp.get('/api/v1/leave/types')).body)).toContain('STUDY');
  });
});
