// Fixtures for the leave / overtime / correction / approval integration tests (fictional people only).
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { addDays, dateOnly, localDate, localDateTime, weekdayOf } from '../src/common/time';
import { as, createDepartment, createUser, webLogin } from './core-fixtures';
import { prisma } from './helpers';

export const DAY = 480;

export async function seedRequestCatalog() {
  const [annual, sick, unpaid, hourly, twoLevel] = await Promise.all([
    prisma.leaveType.create({ data: { code: 'ANNUAL', name: 'Annual leave', nameAr: 'إجازة سنوية', unit: 'DAY', annualEntitlementMinutes: 14 * DAY, accrual: 'YEARLY', carryoverMaxMinutes: 7 * DAY } }),
    prisma.leaveType.create({ data: { code: 'SICK', name: 'Sick leave', unit: 'DAY', annualEntitlementMinutes: 14 * DAY, accrual: 'YEARLY', isSensitive: true } }),
    prisma.leaveType.create({ data: { code: 'UNPAID', name: 'Unpaid leave', isPaid: false, unit: 'DAY', accrual: 'NONE' } }),
    prisma.leaveType.create({ data: { code: 'HOURLY', name: 'Hourly leave', unit: 'HOUR', annualEntitlementMinutes: 24 * 60, accrual: 'YEARLY' } }),
    prisma.leaveType.create({ data: { code: 'STUDY', name: 'Study leave', unit: 'DAY', annualEntitlementMinutes: 5 * DAY, accrual: 'YEARLY', approvalLevels: 2 } }),
  ]);
  const policy = await prisma.overtimePolicy.create({
    data: {
      name: 'Test policy', regularMultiplier: '1.25', weekendMultiplier: '1.50', holidayMultiplier: '2.00',
      minimumMinutes: 15, requiresPreApproval: true, allowRetroApproval: true, isDefault: true,
    },
  });
  return { annual, sick, unpaid, hourly, twoLevel, policy };
}

/** Engineering (manager + two employees) and Operations (manager + one employee), plus HR and an admin. */
export async function seedPeople(app: INestApplication) {
  const eng = await createDepartment('ENG', 'Engineering');
  const ops = await createDepartment('OPS', 'Operations');
  const [hr, admin, mgr, opsMgr, emp, emp2, opsEmp] = await Promise.all([
    createUser({ username: 'hr', roles: ['HR_ADMIN'], departmentId: null }),
    createUser({ username: 'admin', roles: ['SUPER_ADMIN'], departmentId: null }),
    createUser({ username: 'mgr', roles: ['DEPARTMENT_MANAGER'], departmentId: eng.id, manages: [eng.id] }),
    createUser({ username: 'opsmgr', roles: ['DEPARTMENT_MANAGER'], departmentId: ops.id, manages: [ops.id] }),
    createUser({ username: 'emp', roles: ['EMPLOYEE'], departmentId: eng.id }),
    createUser({ username: 'emp2', roles: ['EMPLOYEE'], departmentId: eng.id }),
    createUser({ username: 'opsemp', roles: ['EMPLOYEE'], departmentId: ops.id }),
  ]);
  const login = async (u: { username: string }) => as(app, await webLogin(app, u.username));
  const [hrS, adminS, mgrS, opsMgrS, empS, emp2S, opsEmpS] = await Promise.all([hr, admin, mgr, opsMgr, emp, emp2, opsEmp].map(login));
  return {
    eng, ops,
    users: { hr, admin, mgr, opsMgr, emp, emp2, opsEmp },
    http: { hr: hrS, admin: adminS, mgr: mgrS, opsMgr: opsMgrS, emp: empS, emp2: emp2S, opsEmp: opsEmpS },
  };
}

export const today = () => localDate(new Date());

/** First Sun–Thu (built-in schedule workday) on or after `from`. */
export function workdayFrom(from: string): string {
  let d = from;
  while (weekdayOf(d) > 4) d = addDays(d, 1);
  return d;
}

/** A Sun–Thu workday at least `back` days in the past. */
export function pastWorkday(back = 2): string {
  let d = addDays(today(), -back);
  while (weekdayOf(d) > 4) d = addDays(d, -1);
  return d;
}

/** The next Sunday at least `ahead` days in the future (start of a full Sun–Thu working week). */
export function futureSunday(ahead = 7): string {
  let d = addDays(today(), ahead);
  while (weekdayOf(d) !== 0) d = addDays(d, 1);
  return d;
}

/** A work session with a real CHECK_IN (and CHECK_OUT when closed) event, minutes after local midnight. */
export async function sessionWithEvents(employeeId: string, date: string, startMinute: number, endMinute: number | null, status: 'CLOSED' | 'MISSING_CHECKOUT' | 'OPEN') {
  const id = randomUUID();
  const startedAt = localDateTime(date, startMinute);
  const endedAt = endMinute === null ? null : localDateTime(date, endMinute);
  const base = { employeeId, source: 'WEB' as const, ipAddress: '10.0.0.5', locationVerified: true, workSessionId: id };
  const checkIn = await prisma.attendanceEvent.create({ data: { ...base, type: 'CHECK_IN', occurredAt: startedAt, idempotencyKey: randomUUID() } });
  const checkOut = endedAt && status === 'CLOSED'
    ? await prisma.attendanceEvent.create({ data: { ...base, type: 'CHECK_OUT', occurredAt: endedAt, idempotencyKey: randomUUID() } })
    : null;
  return prisma.workSession.create({
    data: {
      id, employeeId, workDate: dateOnly.toDb(date), startedAt, endedAt: status === 'CLOSED' ? endedAt : null, status,
      startEventId: checkIn.id, endEventId: checkOut?.id ?? null,
    },
  });
}

export const auditActions = async (entityId: string) =>
  (await prisma.auditLog.findMany({ where: { entityId }, orderBy: { seq: 'asc' }, select: { action: true } })).map((a) => a.action);

export const notificationsOf = (userId: string) => prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
