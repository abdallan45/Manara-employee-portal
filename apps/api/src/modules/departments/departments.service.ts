import { Injectable } from '@nestjs/common';
import { Department, Prisma } from '@prisma/client';
import type { DepartmentDto } from '@workforce/shared';
import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../common/auth';
import { Db, PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateDepartmentDto, UpdateDepartmentDto } from './departments.dto';

const invalid = (field: string, message: string) => AppError.badRequest('VALIDATION_FAILED', message, [{ field, messages: [message] }]);

@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(): Promise<DepartmentDto[]> {
    const rows = await this.prisma.department.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
      include: { _count: { select: { employees: { where: { isActive: true, deletedAt: null } } } } },
    });
    return rows.map((d) => this.toDto(d, d._count.employees));
  }

  async create(actor: AuthUser, dto: CreateDepartmentDto): Promise<DepartmentDto> {
    await this.assertCodeFree(dto.code, null);
    if (dto.parentId) await this.assertParent(this.prisma, null, dto.parentId);
    return this.prisma.$transaction(async (tx) => {
      const dept = await tx.department.create({
        data: { code: dto.code, name: dto.name, nameAr: dto.nameAr ?? null, parentId: dto.parentId ?? null },
      });
      const after = this.toDto(dept, 0);
      await this.audit.record(tx, { actorUserId: actor.userId, action: 'DEPARTMENT_CREATE', entityType: 'Department', entityId: dept.id, after, ipAddress: actor.ip });
      return after;
    }).catch((err) => { throw this.mapConflict(err); });
  }

  async update(actor: AuthUser, id: string, dto: UpdateDepartmentDto): Promise<DepartmentDto> {
    const current = await this.load(id);
    if (dto.name === null) throw invalid('name', 'name cannot be empty');
    if (dto.code === null) throw invalid('code', 'code cannot be empty');
    if (dto.code !== undefined && dto.code !== current.code) await this.assertCodeFree(dto.code, id);
    if (dto.parentId) await this.assertParent(this.prisma, id, dto.parentId);
    return this.prisma.$transaction(async (tx) => {
      const count = await this.activeEmployees(tx, id);
      const updated = await tx.department.update({
        where: { id },
        data: { code: dto.code, name: dto.name, nameAr: dto.nameAr, parentId: dto.parentId },
      });
      const after = this.toDto(updated, count);
      await this.audit.record(tx, {
        actorUserId: actor.userId, action: 'DEPARTMENT_UPDATE', entityType: 'Department', entityId: id,
        before: this.toDto(current, count), after, ipAddress: actor.ip,
      });
      return after;
    }).catch((err) => { throw this.mapConflict(err); });
  }

  async remove(actor: AuthUser, id: string): Promise<void> {
    const current = await this.load(id);
    await this.prisma.$transaction(async (tx) => {
      const count = await this.activeEmployees(tx, id);
      if (count > 0) throw AppError.conflict('CONFLICT', `Department still has ${count} active employee(s)`, { activeEmployees: count });
      const children = await tx.department.count({ where: { parentId: id, deletedAt: null } });
      if (children > 0) throw AppError.conflict('CONFLICT', 'Department still has sub-departments', { subDepartments: children });
      await tx.department.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.audit.record(tx, {
        actorUserId: actor.userId, action: 'DEPARTMENT_DELETE', entityType: 'Department', entityId: id,
        before: this.toDto(current, 0), ipAddress: actor.ip,
      });
    });
  }

  private toDto(d: Department, employeeCount: number): DepartmentDto {
    return { id: d.id, code: d.code, name: d.name, nameAr: d.nameAr, parentId: d.parentId, employeeCount };
  }

  private activeEmployees(db: Db, id: string) {
    return db.employee.count({ where: { departmentId: id, isActive: true, deletedAt: null } });
  }

  private async load(id: string): Promise<Department> {
    const dept = await this.prisma.department.findFirst({ where: { id, deletedAt: null } });
    if (!dept) throw AppError.notFound('Department not found');
    return dept;
  }

  private async assertCodeFree(code: string, selfId: string | null): Promise<void> {
    const existing = await this.prisma.department.findUnique({ where: { code }, select: { id: true } });
    if (existing && existing.id !== selfId) throw AppError.conflict('CONFLICT', 'A department with this code already exists');
  }

  /** The parent must exist and must not be the department itself or one of its descendants. */
  private async assertParent(db: Db, selfId: string | null, parentId: string): Promise<void> {
    let cursor: string | null = parentId;
    for (let depth = 0; cursor && depth < 100; depth++) {
      if (cursor === selfId) throw invalid('parentId', 'A department cannot be nested under itself');
      const node: { parentId: string | null; deletedAt: Date | null } | null =
        await db.department.findUnique({ where: { id: cursor }, select: { parentId: true, deletedAt: true } });
      if (!node || (depth === 0 && node.deletedAt)) throw invalid('parentId', 'Parent department does not exist');
      cursor = node.parentId;
    }
  }

  private mapConflict(err: unknown): unknown {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return AppError.conflict('CONFLICT', 'A department with this code already exists');
    }
    return err;
  }
}
