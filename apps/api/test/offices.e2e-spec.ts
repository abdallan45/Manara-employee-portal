import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { GeofenceService } from '../src/modules/offices/geofence.service';
import { AT_OFFICE, OFFICE } from './attendance-fixtures';
import { as, createUser, expectErrorEnvelope, webLogin } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

let app: INestApplication;
let admin: ReturnType<typeof as>;
let worker: ReturnType<typeof as>;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  app.get(GeofenceService).invalidate();
  await createUser({ username: 'root', roles: ['SUPER_ADMIN'] });
  await createUser({ username: 'worker', roles: ['EMPLOYEE'] });
  admin = as(app, await webLogin(app, 'root'));
  worker = as(app, await webLogin(app, 'worker'));
});

const fieldsOf = (body: { error: { details: { field: string }[] } }) => body.error.details.map((d) => d.field).sort();

describe('offices (e2e)', () => {
  it('creates, lists, updates and deletes an office, with audit entries and a fresh geofence', async () => {
    expect((await worker.get('/api/v1/attendance/me/status')).body.location.offices).toEqual([]);

    const created = await admin.post('/api/v1/offices').send({ name: '  Amman HQ ', address: 'Abdali', ...OFFICE });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: expect.any(String), name: 'Amman HQ', address: 'Abdali', ...OFFICE, isActive: true, createdAt: expect.any(String),
    });
    const id = created.body.id as string;
    const defaults = await admin.post('/api/v1/offices').send({ name: 'Branch', latitude: 32.5568, longitude: 35.8469 });
    expect(defaults.body).toMatchObject({ radiusMeters: 150, isActive: true, address: null });

    expect((await admin.get('/api/v1/offices')).body.map((o: { name: string }) => o.name)).toEqual(['Amman HQ', 'Branch']);
    expect((await worker.get('/api/v1/attendance/me/status')).body.location.offices.map((o: { name: string }) => o.name)).toEqual(['Amman HQ', 'Branch']);

    const moved = await admin.patch(`/api/v1/offices/${id}`).send({ radiusMeters: 300, latitude: 31.95 });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ name: 'Amman HQ', latitude: 31.95, longitude: OFFICE.longitude, radiusMeters: 300 });
    const off = await admin.patch(`/api/v1/offices/${defaults.body.id}`).send({ isActive: false, address: '' });
    expect(off.body).toMatchObject({ isActive: false, address: null });
    expect((await worker.get('/api/v1/attendance/me/status')).body.location.offices).toEqual([
      { id, name: 'Amman HQ', latitude: 31.95, longitude: OFFICE.longitude, radiusMeters: 300 },
    ]);

    expect((await admin.delete(`/api/v1/offices/${defaults.body.id}`)).status).toBe(200);
    expect((await admin.get('/api/v1/offices')).body).toHaveLength(1);
    expect((await admin.delete(`/api/v1/offices/${defaults.body.id}`)).status).toBe(404);
    expect((await admin.patch(`/api/v1/offices/${randomUUID()}`).send({ name: 'Nowhere' })).status).toBe(404);
    expect((await admin.patch('/api/v1/offices/not-a-uuid').send({ name: 'Nowhere' })).status).toBe(400);

    const audits = await prisma.auditLog.findMany({ where: { entityType: 'Location' }, orderBy: { seq: 'asc' } });
    expect(audits.map((a) => a.action)).toEqual(['OFFICE_CREATE', 'OFFICE_CREATE', 'OFFICE_UPDATE', 'OFFICE_UPDATE', 'OFFICE_DELETE']);
    expect(audits[2].before).toMatchObject({ radiusMeters: 150, latitude: OFFICE.latitude });
    expect(audits[2].after).toMatchObject({ radiusMeters: 300, latitude: 31.95 });
    expect(audits[4]).toMatchObject({ entityId: defaults.body.id, after: null });
  });

  it('validates coordinates, radius and name', async () => {
    const reject = async (body: object, fields: string[]) => {
      const res = await admin.post('/api/v1/offices').send(body);
      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'VALIDATION_FAILED');
      expect(fieldsOf(res.body)).toEqual(fields);
    };
    await reject({ name: 'Pole', ...OFFICE, latitude: 91 }, ['latitude']);
    await reject({ name: 'Dateline', ...OFFICE, longitude: 181 }, ['longitude']);
    await reject({ name: 'Text', ...OFFICE, latitude: '31.9' }, ['latitude']);
    await reject({ name: 'Tiny', ...OFFICE, radiusMeters: 19 }, ['radiusMeters']);
    await reject({ name: 'Huge', ...OFFICE, radiusMeters: 5001 }, ['radiusMeters']);
    await reject({ name: 'Fraction', ...OFFICE, radiusMeters: 150.5 }, ['radiusMeters']);
    await reject({ name: '', ...OFFICE }, ['name']);
    await reject({ name: 'Nowhere' }, ['latitude', 'longitude']);
    expect(await prisma.location.count()).toBe(0);

    expect((await admin.post('/api/v1/offices').send({ name: 'Edge', ...OFFICE, radiusMeters: 20 })).status).toBe(201);
    expect((await admin.post('/api/v1/offices').send({ name: 'Wide', ...OFFICE, radiusMeters: 5000 })).status).toBe(201);
    const office = await prisma.location.findFirstOrThrow({ where: { name: 'Edge' } });
    expect((await admin.patch(`/api/v1/offices/${office.id}`).send({ latitude: -91 })).status).toBe(400);
    expect((await admin.patch(`/api/v1/offices/${office.id}`).send({ radiusMeters: 0 })).status).toBe(400);
  });

  it('refuses to leave an active office without coordinates', async () => {
    const legacy = await prisma.location.create({ data: { name: 'Amman HQ' } });
    const rename = await admin.patch(`/api/v1/offices/${legacy.id}`).send({ name: 'Head office' });
    expect(rename.status).toBe(400);
    expectErrorEnvelope(rename.body, 'VALIDATION_FAILED');
    expect((await admin.patch(`/api/v1/offices/${legacy.id}`).send({ latitude: OFFICE.latitude })).status).toBe(400);
    expect((await admin.patch(`/api/v1/offices/${legacy.id}`).send({ isActive: false, name: 'Head office' })).status).toBe(200);
    expect((await admin.patch(`/api/v1/offices/${legacy.id}`).send({ isActive: true })).status).toBe(400);
    const located = await admin.patch(`/api/v1/offices/${legacy.id}`).send({ isActive: true, latitude: OFFICE.latitude, longitude: OFFICE.longitude });
    expect(located.status).toBe(200);
    expect(located.body).toMatchObject({ name: 'Head office', ...OFFICE, isActive: true });
  });

  it('409 when deleting an office used by employees, holidays or attendance events', async () => {
    const make = async (name: string) => (await admin.post('/api/v1/offices').send({ name, ...OFFICE })).body.id as string;
    const staffed = await make('Staffed');
    const withHoliday = await make('Holiday office');
    await prisma.employee.updateMany({ where: { employeeCode: 'T-ROOT' }, data: { locationId: staffed } });
    await prisma.holiday.create({ data: { date: new Date('2026-12-25'), name: 'Winter Day', locationId: withHoliday } });
    for (const id of [staffed, withHoliday]) {
      const res = await admin.delete(`/api/v1/offices/${id}`);
      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'CONFLICT');
    }

    // The only active office now is 'Punched'; a check-in there records it on the event.
    await prisma.location.updateMany({ data: { isActive: false } });
    const punched = await make('Punched');
    const checkIn = await worker.post('/api/v1/attendance/me/check-in').send({ idempotencyKey: randomUUID(), location: AT_OFFICE });
    expect(checkIn.status).toBe(200);
    expect((await prisma.attendanceEvent.findFirstOrThrow()).officeId).toBe(punched);
    expect((await admin.delete(`/api/v1/offices/${punched}`)).status).toBe(409);
    expect(await prisma.location.count()).toBe(3);
    expect(await prisma.auditLog.count({ where: { action: 'OFFICE_DELETE' } })).toBe(0);
  });

  it('403 without offices.manage (employees and, by default, HR)', async () => {
    const office = await prisma.location.create({ data: { name: 'HQ', ...OFFICE } });
    await createUser({ username: 'hr', roles: ['HR_ADMIN'] });
    for (const who of [worker, as(app, await webLogin(app, 'hr'))]) {
      expect((await who.get('/api/v1/offices')).status).toBe(403);
      expect((await who.post('/api/v1/offices').send({ name: 'Mine', ...OFFICE })).status).toBe(403);
      expect((await who.patch(`/api/v1/offices/${office.id}`).send({ radiusMeters: 5000 })).status).toBe(403);
      expect((await who.delete(`/api/v1/offices/${office.id}`)).status).toBe(403);
    }
    expect(await prisma.location.findUniqueOrThrow({ where: { id: office.id } })).toMatchObject({ radiusMeters: 150 });
  });
});
