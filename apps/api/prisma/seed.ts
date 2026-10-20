/**
 * Idempotent seed: RBAC, organisation structure, schedules, break/leave types, overtime policy and users.
 * Existing rows are left alone (passwords and flags of existing users are never reset).
 *
 * Modes:
 *  - default (production): reference data + only the `admin` user, flagged must_change_password so the
 *    generated/initial password has to be replaced at first sign-in. The office gets no coordinates, so
 *    check-in stays closed until an administrator sets the office location.
 *  - SEED_DEMO_DATA=true (local development only): additionally the fictional demo people (hr, manager and
 *    the employees) without the must-change flag so one-click demo login stays smooth, and made-up office
 *    coordinates in Amman.
 *
 * Passwords: SEED_DEFAULT_PASSWORD if set, otherwise a random password per newly created user.
 * Generated credentials are written to apps/api/.seed-credentials.txt (git-ignored); only the path is printed.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { PrismaClient, ScheduleType } from '@prisma/client';
import { SYSTEM_ROLES } from '@workforce/shared';
import { AuditService } from '../src/modules/audit/audit.service';
import { hashPassword, PASSWORD_MIN } from '../src/modules/auth/password';
import { ensureRbac } from './rbac';

export const seedClient = new PrismaClient();
const prisma = seedClient;
const audit = new AuditService();
// apps/api/.seed-credentials.txt whether run from prisma/ (ts-node) or dist/prisma/ (compiled).
const API_ROOT = basename(dirname(__dirname)) === 'dist' ? join(__dirname, '..', '..') : join(__dirname, '..');
const CREDENTIALS_FILE = join(API_ROOT, '.seed-credentials.txt');

const DEPARTMENTS = [
  { code: 'OPS', name: 'Operations', nameAr: 'العمليات' },
  { code: 'ENG', name: 'Engineering', nameAr: 'الهندسة' },
  { code: 'CRE', name: 'Creative Studio', nameAr: 'الاستوديو الإبداعي' },
];

/** Demo mode only. The real office location is set by an administrator, never guessed by the seed. */
const DEMO_OFFICE = { latitude: 31.9539, longitude: 35.9106, radiusMeters: 150 };

const WORKDAYS = [0, 1, 2, 3, 4]; // Sunday–Thursday

const BREAK_TYPES = [
  { code: 'LUNCH', name: 'Lunch break', nameAr: 'استراحة الغداء', maxMinutes: 60, isPaid: false, countsAsWork: false, notifyAfterMinutes: 60, sortOrder: 1 },
  { code: 'SHORT', name: 'Short break', nameAr: 'استراحة قصيرة', maxMinutes: 15, isPaid: true, countsAsWork: false, notifyAfterMinutes: 15, sortOrder: 2 },
  { code: 'PERSONAL', name: 'Personal break', nameAr: 'استراحة شخصية', maxMinutes: 30, isPaid: false, countsAsWork: false, notifyAfterMinutes: 30, sortOrder: 3 },
  { code: 'OFFICIAL', name: 'Official work break', nameAr: 'مهمة عمل رسمية', maxMinutes: null, isPaid: true, countsAsWork: true, notifyAfterMinutes: 120, sortOrder: 4 },
];

const DAY = 480; // minutes in an 8-hour working day
const LEAVE_TYPES = [
  { code: 'ANNUAL', name: 'Annual leave', nameAr: 'إجازة سنوية', isPaid: true, unit: 'DAY', annualEntitlementMinutes: 14 * DAY, accrual: 'YEARLY', carryoverMaxMinutes: 7 * DAY },
  { code: 'SICK', name: 'Sick leave', nameAr: 'إجازة مرضية', isPaid: true, unit: 'DAY', annualEntitlementMinutes: 14 * DAY, accrual: 'YEARLY', requiresAttachment: true, isSensitive: true },
  { code: 'EMERGENCY', name: 'Emergency leave', nameAr: 'إجازة طارئة', isPaid: true, unit: 'DAY', annualEntitlementMinutes: 3 * DAY, accrual: 'YEARLY' },
  { code: 'UNPAID', name: 'Unpaid leave', nameAr: 'إجازة بدون راتب', isPaid: false, unit: 'DAY', accrual: 'NONE' },
  { code: 'HOURLY', name: 'Hourly leave', nameAr: 'مغادرة ساعية', isPaid: true, unit: 'HOUR', annualEntitlementMinutes: 24 * 60, accrual: 'YEARLY' },
  { code: 'HALF_DAY', name: 'Half-day leave', nameAr: 'إجازة نصف يوم', isPaid: true, unit: 'HALF_DAY', accrual: 'NONE' },
  { code: 'OFFICIAL_BUSINESS', name: 'Official business', nameAr: 'مهمة رسمية', isPaid: true, unit: 'HOUR', accrual: 'NONE' },
  { code: 'REMOTE_WORK', name: 'Remote work', nameAr: 'عمل عن بعد', isPaid: true, unit: 'DAY', accrual: 'NONE', isRemoteWork: true },
  { code: 'COMPENSATORY', name: 'Compensatory time off', nameAr: 'إجازة تعويضية', isPaid: true, unit: 'HOUR', accrual: 'NONE' },
];

interface DemoPerson {
  username: string; code: string; fullName: string; fullNameAr: string; jobTitle: string;
  dept: string; roles: string[]; manages?: string[];
}

// Fictional people for demonstration only.
const PEOPLE: DemoPerson[] = [
  { username: 'admin', code: 'EMP-0001', fullName: 'System Administrator', fullNameAr: 'مسؤول النظام', jobTitle: 'IT Administrator', dept: 'OPS', roles: [SYSTEM_ROLES.SUPER_ADMIN, SYSTEM_ROLES.EMPLOYEE] },
  { username: 'hr', code: 'EMP-0002', fullName: 'Rana Haddad', fullNameAr: 'رنا الحداد', jobTitle: 'HR Manager', dept: 'OPS', roles: [SYSTEM_ROLES.HR_ADMIN, SYSTEM_ROLES.EMPLOYEE] },
  { username: 'manager', code: 'EMP-0003', fullName: 'Karim Nassar', fullNameAr: 'كريم نصّار', jobTitle: 'Engineering Manager', dept: 'ENG', roles: [SYSTEM_ROLES.DEPARTMENT_MANAGER, SYSTEM_ROLES.EMPLOYEE], manages: ['ENG'] },
  { username: 'dev1', code: 'EMP-0101', fullName: 'Yara Khalil', fullNameAr: 'يارا خليل', jobTitle: 'Software Engineer', dept: 'ENG', roles: [SYSTEM_ROLES.EMPLOYEE] },
  { username: 'dev2', code: 'EMP-0102', fullName: 'Fadi Saleh', fullNameAr: 'فادي صالح', jobTitle: 'QA Engineer', dept: 'ENG', roles: [SYSTEM_ROLES.EMPLOYEE] },
  { username: 'ops1', code: 'EMP-0201', fullName: 'Hala Mansour', fullNameAr: 'هالة منصور', jobTitle: 'Operations Coordinator', dept: 'OPS', roles: [SYSTEM_ROLES.EMPLOYEE] },
  { username: 'ops2', code: 'EMP-0202', fullName: 'Tariq Odeh', fullNameAr: 'طارق عودة', jobTitle: 'Facilities Officer', dept: 'OPS', roles: [SYSTEM_ROLES.EMPLOYEE] },
  { username: 'design1', code: 'EMP-0301', fullName: 'Lama Shaheen', fullNameAr: 'لمى شاهين', jobTitle: 'Motion Designer', dept: 'CRE', roles: [SYSTEM_ROLES.EMPLOYEE] },
  { username: 'design2', code: 'EMP-0302', fullName: 'Nour Hamdan', fullNameAr: 'نور حمدان', jobTitle: 'Illustrator', dept: 'CRE', roles: [SYSTEM_ROLES.EMPLOYEE] },
];

export interface SeedPlan {
  demo: boolean;
  people: (DemoPerson & { mustChangePassword: boolean })[];
  office: { latitude: number; longitude: number; radiusMeters: number } | null;
}

/** What the seed will create for the given environment (pure; unit-tested). */
export function seedPlan(env: NodeJS.ProcessEnv = process.env): SeedPlan {
  const demo = env.SEED_DEMO_DATA === 'true';
  const people = demo
    ? PEOPLE.map((p) => ({ ...p, mustChangePassword: false }))
    : PEOPLE.filter((p) => p.username === 'admin').map((p) => ({ ...p, mustChangePassword: true }));
  return { demo, people, office: demo ? DEMO_OFFICE : null };
}

function seedPassword(): string {
  const fromEnv = process.env.SEED_DEFAULT_PASSWORD;
  if (fromEnv) {
    if (fromEnv.length < PASSWORD_MIN) throw new Error(`SEED_DEFAULT_PASSWORD must be at least ${PASSWORD_MIN} characters`);
    return fromEnv;
  }
  return randomBytes(12).toString('base64url');
}

async function seedOrganisation(plan: SeedPlan) {
  let location = await prisma.location.findFirst({ where: { name: 'Amman HQ' } });
  location ??= await prisma.location.create({ data: { name: 'Amman HQ', timezone: 'Asia/Amman', address: 'Amman, Jordan' } });
  if (plan.office && location.latitude === null) {
    location = await prisma.location.update({ where: { id: location.id }, data: plan.office });
  }

  const deptIds = new Map<string, string>();
  for (const d of DEPARTMENTS) {
    const dept = await prisma.department.upsert({ where: { code: d.code }, update: {}, create: d });
    deptIds.set(d.code, dept.id);
  }

  return { locationId: location.id, deptIds };
}

async function seedSchedules(deptIds: Map<string, string>) {
  const flexible = await prisma.workSchedule.upsert({
    where: { name: 'Flexible 40h' },
    update: {},
    create: {
      name: 'Flexible 40h', type: ScheduleType.FLEXIBLE, weeklyRequiredMinutes: 5 * 480, graceMinutes: 10,
      coreStartMinute: 10 * 60, coreEndMinute: 14 * 60, isDefault: true,
      days: {
        create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => WORKDAYS.includes(weekday)
          ? { weekday, isWorkday: true, startMinute: null, endMinute: null, requiredMinutes: 480 }
          : { weekday, isWorkday: false, startMinute: null, endMinute: null, requiredMinutes: 0 }),
      },
    },
  });
  const fixed = await prisma.workSchedule.upsert({
    where: { name: 'Fixed 09:00–17:00' },
    update: {},
    create: {
      name: 'Fixed 09:00–17:00', type: ScheduleType.FIXED, weeklyRequiredMinutes: 5 * 480, graceMinutes: 10, isDefault: false,
      days: {
        create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => WORKDAYS.includes(weekday)
          ? { weekday, isWorkday: true, startMinute: 540, endMinute: 1020, requiredMinutes: 480 }
          : { weekday, isWorkday: false, startMinute: null, endMinute: null, requiredMinutes: 0 }),
      },
    },
  });
  // Operations works fixed hours; everyone else falls back to the default flexible schedule.
  const opsId = deptIds.get('OPS')!;
  const assigned = await prisma.scheduleAssignment.findFirst({ where: { departmentId: opsId, scheduleId: fixed.id } });
  if (!assigned) {
    await prisma.scheduleAssignment.create({ data: { scheduleId: fixed.id, departmentId: opsId, validFrom: new Date('2026-01-01T00:00:00.000Z') } });
  }
  return { flexibleId: flexible.id, fixedId: fixed.id };
}

async function seedCatalogs() {
  for (const b of BREAK_TYPES) {
    await prisma.breakType.upsert({ where: { code: b.code }, update: {}, create: { ...b, requiresApproval: false, isActive: true } });
  }
  for (const l of LEAVE_TYPES) {
    await prisma.leaveType.upsert({ where: { code: l.code }, update: {}, create: l });
  }
  await prisma.overtimePolicy.upsert({
    where: { name: 'Default overtime policy' },
    update: {},
    create: {
      name: 'Default overtime policy',
      regularMultiplier: '1.25',
      weekendMultiplier: '1.50',
      holidayMultiplier: '1.50',
      minimumMinutes: 15,
      requiresPreApproval: true,
      allowRetroApproval: true,
      isDefault: true,
      notes:
        'Company-configurable starting values only. Statutory overtime rates must be verified against the current ' +
        'Jordanian Labour Law and any applicable regulations before use in payroll.',
    },
  });
}

async function seedPeople(plan: SeedPlan, locationId: string, deptIds: Map<string, string>): Promise<{ username: string; password: string }[]> {
  const roles = await prisma.role.findMany();
  const roleId = new Map(roles.map((r) => [r.key, r.id]));
  const created: { username: string; password: string }[] = [];
  const employeeIdByUsername = new Map<string, string>();

  for (const p of plan.people) {
    const existing = await prisma.user.findUnique({ where: { username: p.username } });
    if (existing) {
      if (existing.employeeId) employeeIdByUsername.set(p.username, existing.employeeId);
      continue;
    }
    if (await prisma.employee.findUnique({ where: { employeeCode: p.code } })) {
      console.warn(`Skipping ${p.username}: employee code ${p.code} already exists without this user`);
      continue;
    }
    const password = seedPassword();
    const passwordHash = await hashPassword(password);
    const grants = p.roles.flatMap((key): { roleId: string; departmentId: string | null }[] =>
      key === SYSTEM_ROLES.DEPARTMENT_MANAGER && p.manages?.length
        ? p.manages.map((code) => ({ roleId: roleId.get(key)!, departmentId: deptIds.get(code)! }))
        : [{ roleId: roleId.get(key)!, departmentId: null }]);

    await prisma.$transaction(async (tx) => {
      const employee = await tx.employee.create({
        data: {
          employeeCode: p.code, fullName: p.fullName, fullNameAr: p.fullNameAr, jobTitle: p.jobTitle,
          departmentId: deptIds.get(p.dept)!, locationId, hireDate: new Date('2026-01-04T00:00:00.000Z'),
          user: { create: { username: p.username, passwordHash, locale: 'ar', mustChangePassword: p.mustChangePassword, roles: { create: grants } } },
        },
        include: { user: true },
      });
      employeeIdByUsername.set(p.username, employee.id);
      await audit.record(tx, {
        actorUserId: null, action: 'SEED_EMPLOYEE_CREATE', entityType: 'Employee', entityId: employee.id,
        after: { employeeCode: p.code, fullName: p.fullName, username: p.username, roles: p.roles, mustChangePassword: p.mustChangePassword },
      });
    });
    created.push({ username: p.username, password });
  }

  // Engineering staff report to the Engineering manager.
  const managerEmployeeId = employeeIdByUsername.get('manager');
  if (managerEmployeeId) {
    const engId = deptIds.get('ENG')!;
    await prisma.employee.updateMany({
      where: { departmentId: engId, managerId: null, id: { not: managerEmployeeId } },
      data: { managerId: managerEmployeeId },
    });
  }
  return created;
}

/** Runs the whole seed (exported for tests; uses DATABASE_URL like the CLI). */
export async function runSeed(): Promise<void> {
  return main();
}

async function main() {
  const plan = seedPlan();
  console.log(plan.demo
    ? 'SEED_DEMO_DATA=true: seeding fictional demo people and a made-up office location (development only).'
    : 'Seeding reference data and the admin account only (set SEED_DEMO_DATA=true for demo people).');
  await ensureRbac(prisma);
  const { locationId, deptIds } = await seedOrganisation(plan);
  await seedSchedules(deptIds);
  await seedCatalogs();
  const created = await seedPeople(plan, locationId, deptIds);

  if (!plan.demo && created.some((c) => c.username === 'admin')) {
    console.log('The admin account must change its password at first sign-in (POST /api/v1/auth/me/password).');
  }
  if (created.length === 0) {
    console.log('Seed complete. No new users were created (existing passwords unchanged).');
    return;
  }
  if (process.env.SEED_DEFAULT_PASSWORD) {
    console.log(`Seed complete. Created ${created.length} user(s) with the password from SEED_DEFAULT_PASSWORD.`);
    return;
  }
  const lines = [
    `# Generated by prisma/seed.ts at ${new Date().toISOString()}. Keep private; delete after distributing.`,
    ...created.map((c) => `${c.username}\t${c.password}`),
    '',
  ];
  writeFileSync(CREDENTIALS_FILE, lines.join('\n'), { encoding: 'utf8', mode: 0o600, flag: 'a' });
  console.log(`Seed complete. Created ${created.length} user(s); credentials written to ${CREDENTIALS_FILE}`);
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
