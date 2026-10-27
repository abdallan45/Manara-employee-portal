import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ALL_PERMISSIONS, RESERVED_STEP_KEYS, SYSTEM_ROLES, type CreateRoleInput, type RoleDto, type UpdateRoleInput } from '@workforce/shared';
import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../common/auth';
import { PrismaService, type Db } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';

export const ROLE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;

const ROLE_INCLUDE = { permissions: { include: { permission: { select: { key: true } } } } } satisfies Prisma.RoleInclude;
type RoleRow = Prisma.RoleGetPayload<{ include: typeof ROLE_INCLUDE }>;

const invalid = (field: string, message: string) => AppError.badRequest('VALIDATION_FAILED', message, [{ field, messages: [message] }]);
const blankToNull = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);

function toRoleDto(r: RoleRow, userCount: number): RoleDto {
  return {
    id: r.id, key: r.key, name: r.name, nameAr: r.nameAr, description: r.description, isSystem: r.isSystem,
    permissions: r.permissions.map((p) => p.permission.key).sort(), userCount,
  };
}

/**
 * Roles & permissions (roles.manage for every write). Built-in roles can be renamed and their
 * permissions changed, except SUPER_ADMIN which always holds every permission; only custom roles can be
 * deleted, and only while nobody holds them and no approval chain names them. Permissions are read on
 * every request, so a change applies to signed-in users at once.
 */
@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService) {}

  /** Active users per role (a department manager of several departments counts once). */
  private async userCounts(db: Db): Promise<Map<string, number>> {
    const grants = await db.userRole.findMany({
      where: { user: { isActive: true, deletedAt: null } }, select: { roleId: true, userId: true }, distinct: ['roleId', 'userId'],
    });
    const out = new Map<string, number>();
    for (const g of grants) out.set(g.roleId, (out.get(g.roleId) ?? 0) + 1);
    return out;
  }

  async list(): Promise<RoleDto[]> {
    const [roles, counts] = await Promise.all([
      this.prisma.role.findMany({ orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }], include: ROLE_INCLUDE }),
      this.userCounts(this.prisma),
    ]);
    return roles.map((r) => toRoleDto(r, counts.get(r.id) ?? 0));
  }

  private async one(db: Db, id: string): Promise<RoleDto> {
    const row = await db.role.findUniqueOrThrow({ where: { id }, include: ROLE_INCLUDE });
    return toRoleDto(row, (await this.userCounts(db)).get(id) ?? 0);
  }

  private async permissionIds(db: Db, keys: string[]): Promise<string[]> {
    const unique = [...new Set(keys)];
    const unknown = unique.filter((k) => !(ALL_PERMISSIONS as string[]).includes(k));
    if (unknown.length) throw invalid('permissions', `Unknown permission(s): ${unknown.join(', ')}`);
    const rows = await db.permission.findMany({ where: { key: { in: unique } }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  private names(input: { name?: string; nameAr?: string | null; description?: string | null }) {
    const name = input.name?.trim();
    if (input.name !== undefined && !name) throw invalid('name', 'name must not be empty');
    return { name, nameAr: blankToNull(input.nameAr), description: blankToNull(input.description) };
  }

  async create(user: AuthUser, input: CreateRoleInput): Promise<RoleDto> {
    const key = input.key.trim();
    if (!ROLE_KEY_PATTERN.test(key)) throw invalid('key', 'key must be 2-40 characters: A-Z, 0-9 and _, starting with a letter');
    if (RESERVED_STEP_KEYS.includes(key)) throw invalid('key', `${key} is reserved`);
    const names = this.names(input);
    if (!names.name) throw invalid('name', 'name must not be empty');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const ids = await this.permissionIds(tx, input.permissions);
        const row = await tx.role.create({
          data: {
            key, name: names.name!, nameAr: names.nameAr ?? null, description: names.description ?? null, isSystem: false,
            permissions: { create: ids.map((permissionId) => ({ permissionId })) },
          },
        });
        const dto = await this.one(tx, row.id);
        await this.audit.record(tx, { actorUserId: user.userId, action: 'ROLE_CREATE', entityType: 'Role', entityId: row.id, after: dto, ipAddress: user.ip });
        return dto;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw AppError.conflict('CONFLICT', 'A role with this key already exists', { key });
      throw e;
    }
  }

  async update(user: AuthUser, id: string, input: UpdateRoleInput): Promise<RoleDto> {
    const names = this.names(input);
    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.findUnique({ where: { id } });
      if (!role) throw AppError.notFound('Role not found');
      const before = await this.one(tx, id);
      if (input.permissions !== undefined) {
        if (role.key === SYSTEM_ROLES.SUPER_ADMIN && [...new Set(input.permissions)].length !== ALL_PERMISSIONS.length) {
          await this.permissionIds(tx, input.permissions); // unknown keys still answer 400
          throw AppError.forbidden('FORBIDDEN', 'SUPER_ADMIN always holds every permission');
        }
        const ids = await this.permissionIds(tx, input.permissions);
        await tx.rolePermission.deleteMany({ where: { roleId: id, permissionId: { notIn: ids } } });
        await tx.rolePermission.createMany({ data: ids.map((permissionId) => ({ roleId: id, permissionId })), skipDuplicates: true });
      }
      await tx.role.update({ where: { id }, data: { name: names.name, nameAr: names.nameAr, description: names.description } });
      const after = await this.one(tx, id);
      await this.audit.record(tx, { actorUserId: user.userId, action: 'ROLE_UPDATE', entityType: 'Role', entityId: id, before, after, ipAddress: user.ip });
      return after;
    });
  }

  /** Where an approval chain names the role (leave types, overtime / correction settings, pending requests). */
  private async chainUses(db: Db, key: string): Promise<string[]> {
    const contains = { approvalSteps: { array_contains: [key] } };
    const [types, leave, overtime, corrections, otSteps, corrSteps] = await Promise.all([
      db.leaveType.findMany({ where: contains, select: { code: true } }),
      db.leaveRequest.count({ where: { status: 'PENDING', ...contains } }),
      db.overtimeRequest.count({ where: { status: 'PENDING', ...contains } }),
      db.attendanceCorrection.count({ where: { status: 'PENDING', ...contains } }),
      this.settings.get('approvals.overtimeSteps'),
      this.settings.get('approvals.correctionSteps'),
    ]);
    return [
      ...types.map((t) => `leaveType:${t.code}`),
      ...(otSteps.includes(key) ? ['approvals.overtimeSteps'] : []),
      ...(corrSteps.includes(key) ? ['approvals.correctionSteps'] : []),
      ...(leave + overtime + corrections > 0 ? ['pendingRequests'] : []),
    ];
  }

  async remove(user: AuthUser, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const role = await tx.role.findUnique({ where: { id } });
      if (!role) throw AppError.notFound('Role not found');
      if (role.isSystem) throw AppError.forbidden('FORBIDDEN', 'Built-in roles cannot be deleted');
      const holders = await tx.userRole.count({ where: { roleId: id } });
      if (holders > 0) throw AppError.conflict('CONFLICT', 'Remove this role from its users first', { reason: 'ASSIGNED', users: holders });
      const uses = await this.chainUses(tx, role.key);
      if (uses.length) throw AppError.conflict('CONFLICT', 'An approval chain still uses this role', { reason: 'IN_APPROVAL_CHAIN', uses });
      const before = await this.one(tx, id);
      await tx.role.delete({ where: { id } });
      await this.audit.record(tx, { actorUserId: user.userId, action: 'ROLE_DELETE', entityType: 'Role', entityId: id, before, ipAddress: user.ip });
    });
  }
}
