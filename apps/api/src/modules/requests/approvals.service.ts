import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  type ApprovalItemDto, type ApprovalSummaryDto, type ApprovalTab, type BulkApproveInput, type BulkApproveResultDto, type Paginated, type RequestKind,
} from '@workforce/shared';
import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { approverFor, type Approver } from './approval-routing';
import { CorrectionsService, type CorrectionRow } from './corrections.service';
import { LeaveService, type LeaveRow } from './leave.service';
import { OvertimeService, type OvertimeRow } from './overtime.service';

const P = PERMISSIONS;
const BULK_MAX = 100;

export interface ApprovalQuery {
  tab: ApprovalTab;
  kind?: RequestKind;
  /** Only this employee's requests (the scope rules still apply). */
  employeeId?: string;
  page: number;
  pageSize: number;
}

interface Approvers { leave: Approver | null; overtime: Approver | null; correction: Approver | null }

/** One inbox over leave, overtime and correction requests, limited to what the viewer may approve. */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leave: LeaveService,
    private readonly overtime: OvertimeService,
    private readonly corrections: CorrectionsService,
  ) {}

  private approvers(user: AuthUser): Approvers {
    const a = {
      leave: approverFor(user, P.LEAVE_APPROVE),
      overtime: approverFor(user, P.OVERTIME_APPROVE),
      correction: approverFor(user, P.CORRECTIONS_APPROVE),
    };
    if (!a.leave && !a.overtime && !a.correction) throw AppError.forbidden();
    return a;
  }

  /**
   * Employees in the approver's scope, never the viewer's own requests (those live on the My pages).
   * `onlyEmployeeId` narrows to one employee inside that scope (the employee page).
   */
  private employeeWhere(a: Approver, onlyEmployeeId?: string) {
    const id = { ...(onlyEmployeeId ? { equals: onlyEmployeeId } : {}), ...(a.employeeId ? { not: a.employeeId } : {}) };
    return {
      ...(Object.keys(id).length ? { employeeId: id } : {}),
      ...(a.companyWide ? {} : { employee: { departmentId: { in: a.departmentIds } } }),
    };
  }

  private leaveWhere(a: Approver, status: Prisma.LeaveRequestWhereInput['status'], onlyEmployeeId?: string): Prisma.LeaveRequestWhereInput {
    // Department managers never see sensitive leave types in the inbox.
    return { status, ...this.employeeWhere(a, onlyEmployeeId), ...(a.companyWide ? {} : { leaveType: { isSensitive: false } }) };
  }

  private async items(user: AuthUser, a: Approvers, rows: { leave: LeaveRow[]; overtime: OvertimeRow[]; correction: CorrectionRow[] }): Promise<ApprovalItemDto[]> {
    const viewer = { userId: user.userId, employeeId: user.employeeId, companyWide: a.leave?.companyWide ?? false };
    const [leave, overtime, correction] = await Promise.all([
      this.leave.toDtos(this.prisma, rows.leave, viewer),
      this.overtime.toDtos(this.prisma, rows.overtime),
      this.corrections.toDtos(this.prisma, rows.correction),
    ]);
    const base = { leave: null, overtime: null, correction: null };
    return [
      ...leave.map((d, i): ApprovalItemDto => ({
        ...base, kind: 'LEAVE', id: d.id, status: d.status, employee: d.employee, submittedAt: d.createdAt, decidedAt: d.decidedAt,
        canAct: this.leave.canAct(a.leave, rows.leave[i]), leave: d,
      })),
      ...overtime.map((d, i): ApprovalItemDto => ({
        ...base, kind: 'OVERTIME', id: d.id, status: d.status, employee: d.employee, submittedAt: d.createdAt, decidedAt: d.decidedAt,
        canAct: this.overtime.canAct(a.overtime, rows.overtime[i]), overtime: d,
      })),
      ...correction.map((d, i): ApprovalItemDto => ({
        ...base, kind: 'CORRECTION', id: d.id, status: d.status, employee: d.employee, submittedAt: d.createdAt, decidedAt: d.decidedAt,
        canAct: this.corrections.canAct(a.correction, rows.correction[i]), correction: d,
      })),
    ];
  }

  private async pendingRows(a: Approvers, kind?: RequestKind, employeeId?: string) {
    const want = (k: RequestKind) => !kind || kind === k;
    const [leave, overtime, correction] = await Promise.all([
      a.leave && want('LEAVE')
        ? this.prisma.leaveRequest.findMany({ where: this.leaveWhere(a.leave, 'PENDING', employeeId), include: LeaveService.include, orderBy: { createdAt: 'asc' } })
        : Promise.resolve([]),
      a.overtime && want('OVERTIME')
        ? this.prisma.overtimeRequest.findMany({ where: { status: 'PENDING', ...this.employeeWhere(a.overtime, employeeId) }, include: OvertimeService.include, orderBy: { createdAt: 'asc' } })
        : Promise.resolve([]),
      a.correction && want('CORRECTION')
        ? this.prisma.attendanceCorrection.findMany({ where: { status: 'PENDING', ...this.employeeWhere(a.correction, employeeId) }, include: CorrectionsService.include, orderBy: { createdAt: 'asc' } })
        : Promise.resolve([]),
    ]);
    return { leave, overtime, correction };
  }

  async list(user: AuthUser, q: ApprovalQuery): Promise<Paginated<ApprovalItemDto>> {
    const a = this.approvers(user);
    const want = (k: RequestKind) => !q.kind || q.kind === k;
    const skip = (q.page - 1) * q.pageSize;

    if (q.tab === 'PENDING') {
      // Pending work is small (one company); load it all so "can act" items sort first.
      const items = await this.items(user, a, await this.pendingRows(a, q.kind, q.employeeId));
      items.sort((x, y) => Number(y.canAct) - Number(x.canAct) || x.submittedAt.localeCompare(y.submittedAt));
      return { items: items.slice(skip, skip + q.pageSize), total: items.length, page: q.page, pageSize: q.pageSize };
    }

    // Decided tabs: take the newest page·size rows of each kind, merge, slice.
    const status = q.tab;
    const take = q.page * q.pageSize;
    const order = [{ decidedAt: 'desc' as const }, { createdAt: 'desc' as const }];
    const leaveWhere = a.leave && want('LEAVE') ? this.leaveWhere(a.leave, status, q.employeeId) : null;
    const overtimeWhere = a.overtime && want('OVERTIME') ? { status, ...this.employeeWhere(a.overtime, q.employeeId) } : null;
    const correctionWhere = a.correction && want('CORRECTION') ? { status, ...this.employeeWhere(a.correction, q.employeeId) } : null;
    const [leave, overtime, correction, counts] = await Promise.all([
      leaveWhere ? this.prisma.leaveRequest.findMany({ where: leaveWhere, include: LeaveService.include, orderBy: order, take }) : Promise.resolve([]),
      overtimeWhere ? this.prisma.overtimeRequest.findMany({ where: overtimeWhere, include: OvertimeService.include, orderBy: order, take }) : Promise.resolve([]),
      correctionWhere ? this.prisma.attendanceCorrection.findMany({ where: correctionWhere, include: CorrectionsService.include, orderBy: order, take }) : Promise.resolve([]),
      Promise.all([
        leaveWhere ? this.prisma.leaveRequest.count({ where: leaveWhere }) : 0,
        overtimeWhere ? this.prisma.overtimeRequest.count({ where: overtimeWhere }) : 0,
        correctionWhere ? this.prisma.attendanceCorrection.count({ where: correctionWhere }) : 0,
      ]),
    ]);
    const items = await this.items(user, a, { leave, overtime, correction });
    items.sort((x, y) => (y.decidedAt ?? '').localeCompare(x.decidedAt ?? '') || y.submittedAt.localeCompare(x.submittedAt));
    return { items: items.slice(skip, skip + q.pageSize), total: counts.reduce((s, n) => s + n, 0), page: q.page, pageSize: q.pageSize };
  }

  async summary(user: AuthUser): Promise<ApprovalSummaryDto> {
    const a = this.approvers(user);
    const items = await this.items(user, a, await this.pendingRows(a));
    const count = (k: RequestKind) => items.filter((i) => i.kind === k && i.canAct).length;
    const pending = { leave: count('LEAVE'), overtime: count('OVERTIME'), correction: count('CORRECTION'), total: 0 };
    pending.total = pending.leave + pending.overtime + pending.correction;
    return { pending };
  }

  async decide(user: AuthUser, kind: RequestKind, id: string, decision: 'APPROVED' | 'REJECTED', comment?: string): Promise<ApprovalItemDto> {
    const a = this.approvers(user);
    switch (kind) {
      case 'LEAVE':
        await this.leave.decide(user, id, decision, comment);
        break;
      case 'OVERTIME':
        await this.overtime.decide(user, id, decision, comment);
        break;
      case 'CORRECTION':
        await this.corrections.decide(user, id, decision, comment);
        break;
    }
    return this.item(user, a, kind, id);
  }

  private async item(user: AuthUser, a: Approvers, kind: RequestKind, id: string): Promise<ApprovalItemDto> {
    const rows = { leave: [] as LeaveRow[], overtime: [] as OvertimeRow[], correction: [] as CorrectionRow[] };
    if (kind === 'LEAVE') rows.leave = await this.prisma.leaveRequest.findMany({ where: { id }, include: LeaveService.include });
    if (kind === 'OVERTIME') rows.overtime = await this.prisma.overtimeRequest.findMany({ where: { id }, include: OvertimeService.include });
    if (kind === 'CORRECTION') rows.correction = await this.prisma.attendanceCorrection.findMany({ where: { id }, include: CorrectionsService.include });
    const [item] = await this.items(user, a, rows);
    if (!item) throw AppError.notFound();
    return item;
  }

  /** Approves each item on its own (its own transaction and permission check); failures do not stop the rest. */
  async bulkApprove(user: AuthUser, input: BulkApproveInput): Promise<BulkApproveResultDto> {
    this.approvers(user);
    if (input.items.length > BULK_MAX) throw AppError.badRequest('VALIDATION_FAILED', `At most ${BULK_MAX} items at once`, { max: BULK_MAX });
    const results: BulkApproveResultDto['results'] = [];
    for (const { kind, id } of input.items) {
      try {
        const item = await this.decide(user, kind, id, 'APPROVED', input.comment);
        results.push({ kind, id, ok: true, status: item.status, error: null });
      } catch (e) {
        const code = e instanceof AppError ? e.code : 'INTERNAL_ERROR';
        results.push({ kind, id, ok: false, status: null, error: code });
      }
    }
    const approved = results.filter((r) => r.ok).length;
    return { approved, failed: results.length - approved, results };
  }
}
