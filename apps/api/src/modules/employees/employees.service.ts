import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EmployeeDto, Paginated, PERMISSIONS, SYSTEM_ROLES } from '@workforce/shared';
import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../common/auth';
import { Db, PrismaService } from '../../common/prisma.service';
import { departmentScope, inScope } from '../../common/scope';
import { dateOnly } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { hashPassword } from '../auth/password';
import { SessionService } from '../auth/session.service';
import { CreateEmployeeDto, EmployeeListQueryDto, UpdateEmployeeDto } from './employees.dto';

const EMPLOYEE_INCLUDE = {
  department: { select: { name: true, nameAr: true } },
  user: { include: { roles: { include: { role: { select: { key: true } } }, orderBy: { createdAt: 'asc' } } } },
} satisfies Prisma.EmployeeInclude;

type EmployeeRow = Prisma.EmployeeGetPayload<{ include: typeof EMPLOYEE_INCLUDE }>;

/** Granting or revoking these roles requires ROLES_MANAGE. */
const PRIVILEGED_ROLES = new Set<string>([SYSTEM_ROLES.SUPER_ADMIN, SYSTEM_ROLES.HR_ADMIN]);
/** The role whose grants are scoped by managedDepartmentIds. */
const SCOPED_ROLE = SYSTEM_ROLES.DEPARTMENT_MANAGER;

interface RoleGrant { roleId: string; departmentId: string | null }

export function toEmployeeDto(e: EmployeeRow): EmployeeDto {
  return {
    id: e.id,
    employeeCode: e.employeeCode,
    fullName: e.fullName,
    fullNameAr: e.fullNameAr,
    email: e.email,
    phone: e.phone,
    jobTitle: e.jobTitle,
    departmentId: e.departmentId,
    departmentName: e.department?.name ?? null,
    departmentNameAr: e.department?.nameAr ?? null,
    managerId: e.managerId,
    hireDate: e.hireDate ? dateOnly.fromDb(e.hireDate) : null,
    isActive: e.isActive,
    createdAt: e.createdAt.toISOString(),
    user: e.user
      ? {
          id: e.user.id,
          username: e.user.username,
          isActive: e.user.isActive,
          roles: e.user.roles.map((r) => ({ key: r.role.key, departmentId: r.departmentId })),
          lastLoginAt: e.user.lastLoginAt?.toISOString() ?? null,
        }
      : null,
  };
}

const invalid = (field: string, message: string) => AppError.badRequest('VALIDATION_FAILED', message, [{ field, messages: [message] }]);

const charRange = (from: number, to: number) => String.fromCharCode(...Array.from({ length: to - from + 1 }, (_, i) => from + i));
/** Tashkeel (harakat, tanween, shadda, sukun, dagger alef, Quranic marks) and tatweel: deleted when folding. */
const ARABIC_MARKS = charRange(0x0610, 0x061a) + charRange(0x064b, 0x065f) + '\u0670' + charRange(0x06d6, 0x06ed) + '\u0640';
/**
 * Postgres translate() arguments, same mapping as the web's search-normalize: أ إ آ ٱ -> ا, ة -> ه, ى -> ي; every
 * character of FOLD_FROM past the end of FOLD_TO (the marks) is deleted.
 */
const FOLD_FROM = '\u0623\u0625\u0622\u0671\u0629\u0649' + ARABIC_MARKS;
const FOLD_TO = '\u0627\u0627\u0627\u0627\u0647\u064a';
const ARABIC_LETTER = /[\u0620-\u064a\u066e-\u06d3]/;

/** The query folded exactly like the SQL expression in foldedNameMatches (lowercase, translate, collapse spaces). */
export function foldArabic(value: string): string {
  let out = '';
  for (const ch of value.toLowerCase()) {
    const i = FOLD_FROM.indexOf(ch);
    out += i < 0 ? ch : FOLD_TO.charAt(i);
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** ٠-٩ and ۰-۹ -> 0-9, so an employee code typed with Arabic-Indic digits still matches. */
const latinDigits = (value: string) => value.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) & 0xf));

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  private readScope(user: AuthUser) {
    return departmentScope(user, PERMISSIONS.EMPLOYEES_MANAGE, PERMISSIONS.EMPLOYEES_READ);
  }

  async list(user: AuthUser, q: EmployeeListQueryDto): Promise<Paginated<EmployeeDto>> {
    const scope = this.readScope(user);
    const and: Prisma.EmployeeWhereInput[] = [{ deletedAt: null }];
    if (scope !== null) and.push({ departmentId: { in: scope } });
    if (q.departmentId) and.push({ departmentId: q.departmentId });
    if (q.status === 'active') and.push({ isActive: true });
    if (q.status === 'inactive') and.push({ isActive: false });
    if (q.search) {
      // Plain case-insensitive substring match (Latin names, codes, usernames), also with Arabic-Indic digits as 0-9.
      const or = [...new Set([q.search, latinDigits(q.search)])].flatMap((term): Prisma.EmployeeWhereInput[] => {
        const contains = { contains: term, mode: 'insensitive' as const };
        return [{ employeeCode: contains }, { fullName: contains }, { fullNameAr: contains }, { user: { username: contains } }];
      });
      // Arabic names also match when only hamza forms, ta marbuta, alef maqsura, tashkeel or tatweel differ.
      const folded = foldArabic(q.search);
      if (ARABIC_LETTER.test(folded)) {
        const ids = await this.foldedNameMatches(folded);
        if (ids.length) or.push({ id: { in: ids } });
      }
      and.push({ OR: or });
    }
    const where: Prisma.EmployeeWhereInput = { AND: and };
    const [total, rows] = await Promise.all([
      this.prisma.employee.count({ where }),
      this.prisma.employee.findMany({
        where,
        include: EMPLOYEE_INCLUDE,
        orderBy: [{ employeeCode: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return { items: rows.map(toEmployeeDto), total, page: q.page, pageSize: q.pageSize };
  }

  /**
   * Ids of employees whose name or Arabic name contains `folded` once folded the same way (see foldArabic).
   * Only a pre-filter: scope, status, department and paging still come from the caller's Prisma where.
   */
  private async foldedNameMatches(folded: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM employees
      WHERE deleted_at IS NULL AND (
        strpos(regexp_replace(translate(lower(full_name), ${FOLD_FROM}, ${FOLD_TO}), '[[:space:]]+', ' ', 'g'), ${folded}) > 0
        OR strpos(regexp_replace(translate(lower(coalesce(full_name_ar, '')), ${FOLD_FROM}, ${FOLD_TO}), '[[:space:]]+', ' ', 'g'), ${folded}) > 0
      )`;
    return rows.map((r) => r.id);
  }

  async get(user: AuthUser, id: string): Promise<EmployeeDto> {
    const scope = this.readScope(user);
    const row = await this.prisma.employee.findFirst({ where: { id, deletedAt: null }, include: EMPLOYEE_INCLUDE });
    // Out-of-scope records are reported as missing so their existence is not disclosed.
    if (!row || !inScope(scope, row.departmentId)) throw AppError.notFound('Employee not found');
    return toEmployeeDto(row);
  }

  async create(actor: AuthUser, dto: CreateEmployeeDto): Promise<EmployeeDto> {
    const roleKeys = dto.roleKeys?.length ? dto.roleKeys : [SYSTEM_ROLES.EMPLOYEE];
    this.assertCanChangePrivileged(actor, new Set(), new Set(roleKeys));

    await this.assertUnique(dto.employeeCode, dto.username);
    await this.assertDepartment(this.prisma, dto.departmentId);
    await this.assertManager(this.prisma, dto.managerId, null);
    const grants = await this.resolveGrants(this.prisma, roleKeys, dto.managedDepartmentIds ?? []);
    const passwordHash = await hashPassword(dto.password);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const employee = await tx.employee.create({
          data: {
            employeeCode: dto.employeeCode,
            fullName: dto.fullName,
            fullNameAr: dto.fullNameAr ?? null,
            email: dto.email ?? null,
            phone: dto.phone ?? null,
            jobTitle: dto.jobTitle ?? null,
            departmentId: dto.departmentId ?? null,
            managerId: dto.managerId ?? null,
            hireDate: dto.hireDate ? dateOnly.toDb(dto.hireDate) : null,
            user: {
              create: {
                username: dto.username,
                passwordHash,
                // Set by an administrator: the person must choose their own password at first sign-in.
                mustChangePassword: true,
                roles: { create: grants },
              },
            },
          },
          include: EMPLOYEE_INCLUDE,
        });
        const after = toEmployeeDto(employee);
        await this.audit.record(tx, {
          actorUserId: actor.userId, action: 'EMPLOYEE_CREATE', entityType: 'Employee', entityId: employee.id,
          after, ipAddress: actor.ip,
        });
        return after;
      });
      return created;
    } catch (err) {
      throw this.mapUniqueViolation(err);
    }
  }

  async update(actor: AuthUser, id: string, dto: UpdateEmployeeDto): Promise<EmployeeDto> {
    for (const field of ['employeeCode', 'fullName', 'username', 'password'] as const) {
      if (dto[field] === null) throw invalid(field, `${field} cannot be empty`);
    }
    const current = await this.loadForWrite(id);
    const isSelf = current.user?.id === actor.userId;
    if (isSelf && dto.password !== undefined) {
      throw AppError.forbidden('FORBIDDEN', 'Change your own password with POST /api/v1/auth/me/password');
    }
    const currentKeys = new Set(current.user?.roles.map((r) => r.role.key) ?? []);
    this.assertCanTouchTarget(actor, currentKeys, isSelf);

    const rolesChanging = dto.roleKeys !== undefined || dto.managedDepartmentIds !== undefined;
    let grants: RoleGrant[] | null = null;
    if (rolesChanging) {
      const nextKeys = dto.roleKeys ?? [...currentKeys];
      const managed = dto.managedDepartmentIds
        ?? (current.user?.roles.filter((r) => r.role.key === SCOPED_ROLE && r.departmentId).map((r) => r.departmentId!) ?? []);
      this.assertCanChangePrivileged(actor, currentKeys, new Set(nextKeys));
      if (isSelf && currentKeys.has(SYSTEM_ROLES.SUPER_ADMIN) && !nextKeys.includes(SYSTEM_ROLES.SUPER_ADMIN)) {
        throw AppError.forbidden('FORBIDDEN', 'You cannot remove your own SUPER_ADMIN role');
      }
      grants = await this.resolveGrants(this.prisma, nextKeys, managed);
    }

    if (dto.employeeCode !== undefined && dto.employeeCode !== current.employeeCode) await this.assertUnique(dto.employeeCode, undefined);
    if (dto.username !== undefined && dto.username !== current.user?.username) await this.assertUnique(undefined, dto.username);
    if (dto.departmentId !== undefined) await this.assertDepartment(this.prisma, dto.departmentId);
    if (dto.managerId !== undefined) await this.assertManager(this.prisma, dto.managerId, id);
    if (!current.user && (dto.username !== undefined || dto.password !== undefined || rolesChanging) && !(dto.username && dto.password)) {
      throw invalid('username', 'This employee has no login yet; provide both username and password to create one');
    }
    const passwordHash = dto.password ? await hashPassword(dto.password) : null;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const before = toEmployeeDto(current);
        await tx.employee.update({
          where: { id },
          data: {
            employeeCode: dto.employeeCode,
            fullName: dto.fullName,
            fullNameAr: dto.fullNameAr,
            email: dto.email,
            phone: dto.phone,
            jobTitle: dto.jobTitle,
            departmentId: dto.departmentId,
            managerId: dto.managerId,
            hireDate: dto.hireDate === undefined ? undefined : dto.hireDate === null ? null : dateOnly.toDb(dto.hireDate),
          },
        });

        let userId = current.user?.id ?? null;
        if (!userId && dto.username && passwordHash) {
          const created = await tx.user.create({
            data: { username: dto.username, passwordHash, mustChangePassword: true, employeeId: id, roles: { create: grants ?? (await this.resolveGrants(tx, [SYSTEM_ROLES.EMPLOYEE], [])) } },
          });
          userId = created.id;
        } else if (userId) {
          await tx.user.update({
            where: { id: userId },
            data: {
              username: dto.username,
              ...(passwordHash ? { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null, mustChangePassword: true } : {}),
            },
          });
          if (grants) {
            await tx.userRole.deleteMany({ where: { userId } });
            await tx.userRole.createMany({ data: grants.map((g) => ({ ...g, userId: userId! })) });
          }
          if (passwordHash) await this.sessions.revokeAllForUser(tx, userId);
        }

        const updated = await tx.employee.findUniqueOrThrow({ where: { id }, include: EMPLOYEE_INCLUDE });
        const after = toEmployeeDto(updated);
        await this.audit.record(tx, {
          actorUserId: actor.userId, action: 'EMPLOYEE_UPDATE', entityType: 'Employee', entityId: id,
          before, after: passwordHash ? { ...after, passwordChanged: true } : after, ipAddress: actor.ip,
        });
        return after;
      });
    } catch (err) {
      throw this.mapUniqueViolation(err);
    }
  }

  async setActive(actor: AuthUser, id: string, active: boolean): Promise<EmployeeDto> {
    const current = await this.loadForWrite(id);
    const isSelf = current.user?.id === actor.userId;
    if (isSelf && !active) throw AppError.forbidden('FORBIDDEN', 'You cannot deactivate your own account');
    this.assertCanTouchTarget(actor, new Set(current.user?.roles.map((r) => r.role.key) ?? []), isSelf);

    return this.prisma.$transaction(async (tx) => {
      const before = toEmployeeDto(current);
      await tx.employee.update({ where: { id }, data: { isActive: active } });
      if (current.user) {
        await tx.user.update({
          where: { id: current.user.id },
          data: active ? { isActive: true, failedLoginCount: 0, lockedUntil: null } : { isActive: false },
        });
        if (!active) await this.sessions.revokeAllForUser(tx, current.user.id);
      }
      const updated = await tx.employee.findUniqueOrThrow({ where: { id }, include: EMPLOYEE_INCLUDE });
      const after = toEmployeeDto(updated);
      await this.audit.record(tx, {
        actorUserId: actor.userId, action: active ? 'EMPLOYEE_ACTIVATE' : 'EMPLOYEE_DEACTIVATE', entityType: 'Employee', entityId: id,
        before, after, ipAddress: actor.ip,
      });
      return after;
    });
  }

  private async loadForWrite(id: string): Promise<EmployeeRow> {
    const row = await this.prisma.employee.findFirst({ where: { id, deletedAt: null }, include: EMPLOYEE_INCLUDE });
    if (!row) throw AppError.notFound('Employee not found');
    return row;
  }

  /** Without ROLES_MANAGE, accounts holding privileged roles can only be edited by their owner. */
  private assertCanTouchTarget(actor: AuthUser, targetRoles: Set<string>, isSelf: boolean): void {
    if (actor.permissions.has(PERMISSIONS.ROLES_MANAGE) || isSelf) return;
    if ([...targetRoles].some((k) => PRIVILEGED_ROLES.has(k))) {
      throw AppError.forbidden('FORBIDDEN', 'Only users with role management permission can modify administrator accounts');
    }
  }

  private assertCanChangePrivileged(actor: AuthUser, before: Set<string>, after: Set<string>): void {
    if (actor.permissions.has(PERMISSIONS.ROLES_MANAGE)) return;
    const changed = [...PRIVILEGED_ROLES].filter((k) => before.has(k) !== after.has(k));
    if (changed.length) {
      throw AppError.forbidden('FORBIDDEN', `Granting or revoking ${changed.join(', ')} requires role management permission`);
    }
  }

  private async assertUnique(employeeCode: string | undefined, username: string | undefined): Promise<void> {
    if (employeeCode !== undefined && (await this.prisma.employee.findUnique({ where: { employeeCode }, select: { id: true } }))) {
      throw AppError.conflict('EMPLOYEE_CODE_TAKEN', 'This employee code is already in use');
    }
    if (username !== undefined && (await this.prisma.user.findUnique({ where: { username }, select: { id: true } }))) {
      throw AppError.conflict('USERNAME_TAKEN', 'This username is already in use');
    }
  }

  private async assertDepartment(db: Db, departmentId: string | null | undefined): Promise<void> {
    if (!departmentId) return;
    const dept = await db.department.findFirst({ where: { id: departmentId, deletedAt: null }, select: { id: true } });
    if (!dept) throw invalid('departmentId', 'Department does not exist');
  }

  private async assertManager(db: Db, managerId: string | null | undefined, selfId: string | null): Promise<void> {
    if (!managerId) return;
    if (managerId === selfId) throw invalid('managerId', 'An employee cannot be their own manager');
    const mgr = await db.employee.findFirst({ where: { id: managerId, deletedAt: null }, select: { id: true } });
    if (!mgr) throw invalid('managerId', 'Manager does not exist');
  }

  private async resolveGrants(db: Db, roleKeys: string[], managedDepartmentIds: string[]): Promise<RoleGrant[]> {
    const keys = [...new Set(roleKeys)];
    const roles = await db.role.findMany({ where: { key: { in: keys } }, select: { id: true, key: true } });
    const unknown = keys.filter((k) => !roles.some((r) => r.key === k));
    if (unknown.length) throw invalid('roleKeys', `Unknown role(s): ${unknown.join(', ')}`);

    const managed = [...new Set(managedDepartmentIds)];
    if (managed.length && !keys.includes(SCOPED_ROLE)) {
      throw invalid('managedDepartmentIds', `managedDepartmentIds requires the ${SCOPED_ROLE} role`);
    }
    if (managed.length) {
      const found = await db.department.count({ where: { id: { in: managed }, deletedAt: null } });
      if (found !== managed.length) throw invalid('managedDepartmentIds', 'One or more managed departments do not exist');
    }

    const grants: RoleGrant[] = [];
    for (const role of roles) {
      if (role.key === SCOPED_ROLE && managed.length) {
        for (const departmentId of managed) grants.push({ roleId: role.id, departmentId });
      } else {
        grants.push({ roleId: role.id, departmentId: null });
      }
    }
    return grants;
  }

  private mapUniqueViolation(err: unknown): unknown {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const target = JSON.stringify(err.meta?.target ?? '');
      if (target.includes('employee_code') || target.includes('employeeCode')) {
        return AppError.conflict('EMPLOYEE_CODE_TAKEN', 'This employee code is already in use');
      }
      if (target.includes('username')) return AppError.conflict('USERNAME_TAKEN', 'This username is already in use');
    }
    return err;
  }
}
