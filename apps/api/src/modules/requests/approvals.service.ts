import { Injectable } from '@nestjs/common';
import type { Prisma, RequestStatus } from '@prisma/client';
import {
  PERMISSIONS,
  type ApprovalItemDto, type ApprovalSummaryDto, type ApprovalTab, type BulkApproveInput, type BulkApproveResultDto, type Paginated, type RequestKind,
} from '@workforce/shared';
import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { approverFor, coversEmployee, parseSteps, stepAt, type Approver } from './approval-routing';
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

/** Where a pending request stands in its chain, for the inbox. */
function chainPosition(row: { status: string; currentLevel: number; approvalSteps: unknown }) {
  const steps = parseSteps(row.approvalSteps);
  return {
    currentStep: row.status === 'PENDING' ? stepAt(steps, row.currentLevel) : null,
    currentLevel: row.currentLevel,
    totalLevels: steps.length,
  };
}

const sees = (a: Approver) => a.companyWide || a.superAdmin;

/**
 * One inbox over leave, overtime and correction requests. Pending: what the viewer can decide now
 * (the request's current step is theirs) plus, for information, the other pending requests of the
 * employees they see. History: decided requests of the employees they see and every request they
 * decided themselves.
 */
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

  /** Never the viewer's own requests (those live on the My pages); `onlyEmployeeId` narrows to one employee. */
  private employeeIdWhere(a: Approver, onlyEmployeeId?: string) {
    const id = { ...(onlyEmployeeId ? { equals: onlyEmployeeId } : {}), ...(a.employeeId ? { not: a.employeeId } : {}) };
    return Object.keys(id).length ? { employeeId: id } : {};
  }

  /** Decided requests the viewer may list: their team's (everyone's for HR) and the ones they decided. */
  private historyWhere(a: Approver, status: RequestStatus, onlyEmployeeId?: string) {
    if (sees(a)) return { status, ...this.employeeIdWhere(a, onlyEmployeeId) };
    return {
      status, ...this.employeeIdWhere(a, onlyEmployeeId),
      OR: [
        { employee: { OR: [{ departmentId: { in: a.departmentIds } }, { id: { in: a.employeeIds } }] } },
        { approvals: { some: { approverUserId: a.userId } } },
      ],
    };
  }

  private leaveHistoryWhere(a: Approver, status: RequestStatus, onlyEmployeeId?: string): Prisma.LeaveRequestWhereInput {
    // Managers never see sensitive leave types.
    return { ...this.historyWhere(a, status, onlyEmployeeId), ...(sees(a) ? {} : { leaveType: { isSensitive: false } }) };
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
        canAct: this.leave.canAct(a.leave, rows.leave[i]),
        // The chain of a confidential type could identify it.
        ...(d.confidential ? { currentStep: null, currentLevel: 0, totalLevels: 0 } : chainPosition(rows.leave[i])),
        leave: d,
      })),
      ...overtime.map((d, i): ApprovalItemDto => ({
        ...base, kind: 'OVERTIME', id: d.id, status: d.status, employee: d.employee, submittedAt: d.createdAt, decidedAt: d.decidedAt,
        canAct: this.overtime.canAct(a.overtime, rows.overtime[i]), ...chainPosition(rows.overtime[i]), overtime: d,
      })),
      ...correction.map((d, i): ApprovalItemDto => ({
        ...base, kind: 'CORRECTION', id: d.id, status: d.status, employee: d.employee, submittedAt: d.createdAt, decidedAt: d.decidedAt,
        canAct: this.corrections.canAct(a.correction, rows.correction[i]), ...chainPosition(rows.correction[i]), correction: d,
      })),
    ];
  }

  /**
   * Pending work is small (one company): load it all and keep what the viewer can decide or may see.
   * Role steps can make a request decidable by someone outside the employee's team, so the filter runs here.
   */
  private async pendingRows(a: Approvers, kind?: RequestKind, employeeId?: string) {
    const want = (k: RequestKind) => !kind || kind === k;
    const keep = <R extends { employeeId: string; employee: { departmentId: string | null } }>(
      approver: Approver, rows: R[], canAct: (r: R) => boolean, hidden: (r: R) => boolean = () => false,
    ) => rows.filter((r) => canAct(r) || (!hidden(r) && coversEmployee(approver, { employeeId: r.employeeId, departmentId: r.employee.departmentId })));
    const [leave, overtime, correction] = await Promise.all([
      a.leave && want('LEAVE')
        ? this.prisma.leaveRequest.findMany({ where: { status: 'PENDING', ...this.employeeIdWhere(a.leave, employeeId) }, include: LeaveService.include, orderBy: { createdAt: 'asc' } })
        : Promise.resolve([]),
      a.overtime && want('OVERTIME')
        ? this.prisma.overtimeRequest.findMany({ where: { status: 'PENDING', ...this.employeeIdWhere(a.overtime, employeeId) }, include: OvertimeService.include, orderBy: { createdAt: 'asc' } })
        : Promise.resolve([]),
      a.correction && want('CORRECTION')
        ? this.prisma.attendanceCorrection.findMany({ where: { status: 'PENDING', ...this.employeeIdWhere(a.correction, employeeId) }, include: CorrectionsService.include, orderBy: { createdAt: 'asc' } })
        : Promise.resolve([]),
    ]);
    return {
      // Managers never see sensitive leave types unless a step of it is theirs to decide.
      leave: a.leave ? keep(a.leave, leave, (r) => this.leave.canAct(a.leave, r), (r) => r.leaveType.isSensitive && !sees(a.leave!)) : [],
      overtime: a.overtime ? keep(a.overtime, overtime, (r) => this.overtime.canAct(a.overtime, r)) : [],
      correction: a.correction ? keep(a.correction, correction, (r) => this.corrections.canAct(a.correction, r)) : [],
    };
  }

  async list(user: AuthUser, q: ApprovalQuery): Promise<Paginated<ApprovalItemDto>> {
    const a = this.approvers(user);
    const want = (k: RequestKind) => !q.kind || q.kind === k;
    const skip = (q.page - 1) * q.pageSize;

    if (q.tab === 'PENDING') {
      const items = await this.items(user, a, await this.pendingRows(a, q.kind, q.employeeId));
      items.sort((x, y) => Number(y.canAct) - Number(x.canAct) || x.submittedAt.localeCompare(y.submittedAt));
      return { items: items.slice(skip, skip + q.pageSize), total: items.length, page: q.page, pageSize: q.pageSize };
    }

    // Decided tabs: take the newest page·size rows of each kind, merge, slice.
    const status = q.tab;
    const take = q.page * q.pageSize;
    const order = [{ decidedAt: 'desc' as const }, { createdAt: 'desc' as const }];
    const leaveWhere = a.leave && want('LEAVE') ? this.leaveHistoryWhere(a.leave, status, q.employeeId) : null;
    const overtimeWhere: Prisma.OvertimeRequestWhereInput | null = a.overtime && want('OVERTIME') ? this.historyWhere(a.overtime, status, q.employeeId) : null;
    const correctionWhere: Prisma.AttendanceCorrectionWhereInput | null = a.correction && want('CORRECTION') ? this.historyWhere(a.correction, status, q.employeeId) : null;
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
    const rows = await this.pendingRows(a);
    const pending = {
      leave: rows.leave.filter((r) => this.leave.canAct(a.leave, r)).length,
      overtime: rows.overtime.filter((r) => this.overtime.canAct(a.overtime, r)).length,
      correction: rows.correction.filter((r) => this.corrections.canAct(a.correction, r)).length,
      total: 0,
    };
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
