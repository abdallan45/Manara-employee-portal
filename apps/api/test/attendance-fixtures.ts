// Fixture builders for the attendance integration tests (fictional people only).
import { randomUUID } from 'node:crypto';
import { DEFAULT_ROLE_PERMISSIONS, type SystemRole } from '@workforce/shared';
import type { AuthUser } from '../src/common/auth';
import { prisma } from './helpers';

let seq = 0;

export async function makeDepartment(name: string) {
  seq += 1;
  return prisma.department.create({ data: { code: `D${seq}-${randomUUID().slice(0, 6)}`, name } });
}

/** Creates an employee with a linked user holding `role` (scoped to `managedDepartmentId` if given). */
export async function makeEmployee(opts: {
  name: string; departmentId?: string | null; role?: SystemRole; managedDepartmentId?: string; passwordHash?: string;
}) {
  seq += 1;
  const code = `E${String(seq).padStart(4, '0')}`;
  const role = await prisma.role.findUniqueOrThrow({ where: { key: opts.role ?? 'EMPLOYEE' } });
  const employee = await prisma.employee.create({ data: { employeeCode: code, fullName: opts.name, departmentId: opts.departmentId ?? null } });
  const user = await prisma.user.create({
    data: {
      username: `u${code.toLowerCase()}`, passwordHash: opts.passwordHash ?? 'not-a-real-hash', employeeId: employee.id, locale: 'en',
      roles: { create: [{ roleId: role.id, departmentId: opts.managedDepartmentId ?? null }] },
    },
  });
  return { employee, user };
}

export function authUser(
  user: { id: string; username: string }, employeeId: string | null, opts: { role?: SystemRole; ip?: string; managed?: string[] } = {},
): AuthUser {
  const role = opts.role ?? 'EMPLOYEE';
  return {
    userId: user.id, sessionId: randomUUID(), username: user.username, employeeId,
    roles: [role], permissions: new Set<string>(DEFAULT_ROLE_PERMISSIONS[role]),
    managedDepartmentIds: opts.managed ?? [], ip: opts.ip ?? '10.1.2.3',
  };
}

export async function makeBreakType(code: string, over: Partial<{ isPaid: boolean; maxMinutes: number | null; countsAsWork: boolean; notifyAfterMinutes: number | null; isActive: boolean }> = {}) {
  return prisma.breakType.create({ data: { code, name: code.charAt(0) + code.slice(1).toLowerCase(), ...over } });
}

/** Inserts a session directly (bypassing the state machine) for metrics / stale-session fixtures. */
export async function makeSession(employeeId: string, workDate: string, startedAt: Date, endedAt: Date | null, status: 'OPEN' | 'CLOSED' | 'MISSING_CHECKOUT') {
  return prisma.workSession.create({
    data: {
      employeeId, workDate: new Date(`${workDate}T00:00:00.000Z`), startedAt, endedAt, status,
      startEventId: randomUUID(), endEventId: endedAt && status === 'CLOSED' ? randomUUID() : null,
    },
  });
}

/** Amman HQ, as used by the demo seed. */
export const OFFICE = { latitude: 31.9539, longitude: 35.9106, radiusMeters: 150 };
/** A precise fix inside the office geofence. */
export const AT_OFFICE = { latitude: OFFICE.latitude, longitude: OFFICE.longitude, accuracy: 10 };
/** A precise fix about 5 km north of the office. */
export const FAR_AWAY = { latitude: 31.9989, longitude: 35.9106, accuracy: 10 };

/** Creates an active office (geofence) with coordinates; call GeofenceService.invalidate() afterwards. */
export async function makeOffice(over: Partial<{ name: string; latitude: number | null; longitude: number | null; radiusMeters: number; isActive: boolean }> = {}) {
  return prisma.location.create({ data: { name: 'Head office', ...OFFICE, ...over } });
}
