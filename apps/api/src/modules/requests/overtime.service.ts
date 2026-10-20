import { Injectable } from '@nestjs/common';
import { Prisma, type OvertimePolicy, type RequestStatus } from '@prisma/client';
import {
  PERMISSIONS, REQUEST_NOTIFICATION_TYPES,
  type CreateOvertimeRequestInput, type DirectOvertimeInput, type DirectOvertimeResultDto, type OvertimeCandidateDto, type OvertimeCompensation,
  type OvertimeKind, type OvertimePolicyDto, type OvertimeRequestDto,
  type UpdateOvertimePolicyInput,
} from '@workforce/shared';
import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../common/auth';
import { PrismaService, type Db } from '../../common/prisma.service';
import { addDays, dateOnly, localDate } from '../../common/time';
import { AttendanceMetricsService } from '../attendance/attendance-metrics.service';
import { assertDate, daySpan, resolveRange } from '../attendance/date-range';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { ScheduleResolver } from '../schedules/schedule-resolver';
import { approverFor, canDecideSingle, type Approver } from './approval-routing';
import { approvedOvertimeMinutes, compensatedMinutes, multiplierFor, normalizeMultiplier, overtimeKind, retroAllowed } from './overtime-math';
import {
  ApproverDirectory, approvalStepsByRequest, assertMayDecide, EMPLOYEE_REF_SELECT, invalidField, lockEmployee, notPending,
  requireEmployee, toEmployeeRef, TX_OPTIONS,
} from './request-common';

const P = PERMISSIONS;
const MAX_DAYS_AHEAD = 60;
const MAX_DAYS_BACK = 62;

const OVERTIME_INCLUDE = { employee: { select: EMPLOYEE_REF_SELECT }, approvals: true } satisfies Prisma.OvertimeRequestInclude;
export type OvertimeRow = Prisma.OvertimeRequestGetPayload<{ include: typeof OVERTIME_INCLUDE }>;

export const policyToDto = (p: OvertimePolicy): OvertimePolicyDto => ({
  id: p.id, name: p.name,
  regularMultiplier: normalizeMultiplier(p.regularMultiplier.toString()),
  weekendMultiplier: normalizeMultiplier(p.weekendMultiplier.toString()),
  holidayMultiplier: normalizeMultiplier(p.holidayMultiplier.toString()),
  minimumMinutes: p.minimumMinutes, requiresPreApproval: p.requiresPreApproval, allowRetroApproval: p.allowRetroApproval,
  notes: p.notes, isDefault: p.isDefault,
});

@Injectable()
export class OvertimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly resolver: ScheduleResolver,
    private readonly metrics: AttendanceMetricsService,
    private readonly notifications: NotificationService,
    private readonly directory: ApproverDirectory,
  ) {}

  // ───────────── Policy ─────────────

  private async defaultPolicy(db: Db = this.prisma): Promise<OvertimePolicy> {
    const policy = await db.overtimePolicy.findFirst({ orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
    if (!policy) throw AppError.conflict('CONFLICT', 'No overtime policy is configured; ask HR to create one');
    return policy;
  }

  async policy(): Promise<OvertimePolicyDto> {
    return policyToDto(await this.defaultPolicy());
  }

  async updatePolicy(user: AuthUser, id: string, input: UpdateOvertimePolicyInput): Promise<OvertimePolicyDto> {
    const data: Prisma.OvertimePolicyUpdateInput = {};
    for (const key of ['regularMultiplier', 'weekendMultiplier', 'holidayMultiplier'] as const) {
      const v = input[key];
      if (v === undefined) continue;
      let normalized: string;
      try {
        normalized = normalizeMultiplier(v);
      } catch {
        throw invalidField(key, `${key} must be a decimal such as 1.25`);
      }
      if (Number(normalized) < 1 || Number(normalized) > 10) throw invalidField(key, `${key} must be between 1.00 and 10.00`);
      data[key] = normalized;
    }
    if (input.minimumMinutes !== undefined) data.minimumMinutes = input.minimumMinutes;
    if (input.requiresPreApproval !== undefined) data.requiresPreApproval = input.requiresPreApproval;
    if (input.allowRetroApproval !== undefined) data.allowRetroApproval = input.allowRetroApproval;
    if (input.notes !== undefined) data.notes = input.notes;
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.overtimePolicy.findUnique({ where: { id } });
      if (!before) throw AppError.notFound('Overtime policy not found');
      const after = await tx.overtimePolicy.update({ where: { id }, data });
      await this.audit.record(tx, {
        actorUserId: user.userId, action: 'OVERTIME_POLICY_UPDATE', entityType: 'OvertimePolicy', entityId: id, ipAddress: user.ip,
        before: policyToDto(before), after: policyToDto(after),
      });
      return policyToDto(after);
    });
  }

  // ───────────── Requests ─────────────

  /** Extra minutes calc.ts reports per employee/date for days that have ended (today and later -> null). */
  private async recordedExtra(rows: { employeeId: string; workDate: Date }[], employees: Map<string, { id: string; departmentId: string | null; locationId: string | null }>, today: string) {
    const out = new Map<string, number>();
    const past = rows.map((r) => ({ ...r, date: dateOnly.fromDb(r.workDate) })).filter((r) => r.date < today);
    if (!past.length) return out;
    const from = past.reduce((m, r) => (r.date < m ? r.date : m), past[0].date);
    const to = past.reduce((m, r) => (r.date > m ? r.date : m), past[0].date);
    const refs = [...new Set(past.map((r) => r.employeeId))].map((id) => employees.get(id)!).filter(Boolean);
    const { days } = await this.metrics.computeRange(refs, from, to);
    for (const r of past) {
      const metrics = days.get(r.employeeId)?.[daySpan(from, r.date) - 1];
      if (metrics) out.set(`${r.employeeId}|${r.date}`, metrics.extraMinutes);
    }
    return out;
  }

  async create(user: AuthUser, input: CreateOvertimeRequestInput): Promise<OvertimeRequestDto> {
    const employeeId = requireEmployee(user);
    const employee = await this.prisma.employee.findFirst({ where: { id: employeeId, isActive: true, deletedAt: null }, select: EMPLOYEE_REF_SELECT });
    if (!employee) throw AppError.forbidden('NOT_AN_EMPLOYEE', 'No active employee record');
    const workDate = assertDate(input.workDate, 'workDate');
    const today = localDate(new Date());
    if (workDate > addDays(today, MAX_DAYS_AHEAD)) throw invalidField('workDate', `Overtime can be requested at most ${MAX_DAYS_AHEAD} days ahead`);
    if (workDate < addDays(today, -MAX_DAYS_BACK)) throw invalidField('workDate', `Overtime can be requested at most ${MAX_DAYS_BACK} days back`);

    const policy = await this.defaultPolicy();
    const isPreApproval = workDate >= today;
    if (!isPreApproval && !retroAllowed(policy)) {
      throw AppError.conflict('OVERTIME_RETRO_NOT_ALLOWED', 'Overtime must be approved before it is worked', { workDate });
    }
    if (input.minutes < policy.minimumMinutes) {
      throw AppError.badRequest('OVERTIME_BELOW_MINIMUM', `Overtime requests start at ${policy.minimumMinutes} minutes`, { minimumMinutes: policy.minimumMinutes });
    }
    const resolved = (await this.resolver.load([employee], workDate, workDate)).day(employee, workDate);
    const kind = overtimeKind(resolved.rule.isWorkday, resolved.isHoliday);
    if (!isPreApproval) {
      const extra = (await this.recordedExtra([{ employeeId, workDate: dateOnly.toDb(workDate) }], new Map([[employeeId, employee]]), today)).get(`${employeeId}|${workDate}`) ?? 0;
      if (input.minutes > extra) {
        throw AppError.conflict('OVERTIME_EXCEEDS_RECORDED', 'More overtime was requested than the attendance records show', { recordedExtraMinutes: extra, requested: input.minutes });
      }
    }

    const id = await this.prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employeeId);
      const duplicate = await tx.overtimeRequest.findFirst({
        where: { employeeId, workDate: dateOnly.toDb(workDate), status: { in: ['PENDING', 'APPROVED'] } }, select: { id: true, status: true },
      });
      if (duplicate) throw AppError.conflict('DUPLICATE_REQUEST', 'There is already an overtime request for this date', { requestId: duplicate.id, status: duplicate.status });
      const multiplier = multiplierFor(policy, kind);
      const row = await tx.overtimeRequest.create({
        data: {
          employeeId, workDate: dateOnly.toDb(workDate), minutes: input.minutes, kind, compensation: input.compensation ?? 'PAY',
          isPreApproval, reason: input.reason.trim(), policyId: policy.id, multiplier,
        },
      });
      await this.audit.record(tx, {
        actorUserId: user.userId, action: 'OVERTIME_REQUEST_CREATE', entityType: 'OvertimeRequest', entityId: row.id, ipAddress: user.ip,
        after: { employeeId, workDate, minutes: input.minutes, kind, compensation: row.compensation, isPreApproval, policyId: policy.id, multiplier },
      });
      let recipients = await this.directory.team(P.OVERTIME_APPROVE, employee.departmentId, employeeId, tx);
      if (!recipients.length) recipients = await this.directory.companyWide(P.OVERTIME_APPROVE, employeeId, tx);
      await this.notifications.notifyMany(recipients, {
        type: REQUEST_NOTIFICATION_TYPES.PENDING_APPROVAL, title: 'Overtime request waiting for approval',
        body: `${employee.fullName} (${employee.employeeCode}) requested ${input.minutes} minutes of overtime on ${workDate}.`,
        data: {
          type: REQUEST_NOTIFICATION_TYPES.PENDING_APPROVAL, kind: 'OVERTIME', requestId: row.id, workDate, minutes: input.minutes,
          employeeName: employee.fullName, employeeNameAr: employee.fullNameAr, employeeCode: employee.employeeCode,
        },
        dedupeKey: `overtime-pending:${row.id}`,
      }, tx);
      return row.id;
    }, TX_OPTIONS);
    return this.get(id);
  }

  async cancel(user: AuthUser, id: string): Promise<OvertimeRequestDto> {
    const existing = await this.prisma.overtimeRequest.findUnique({ where: { id }, select: { employeeId: true } });
    if (!existing || existing.employeeId !== user.employeeId) throw AppError.notFound('Overtime request not found');
    await this.prisma.$transaction(async (tx) => {
      const now = await lockEmployee(tx, existing.employeeId);
      const req = await tx.overtimeRequest.findUniqueOrThrow({ where: { id } });
      if (req.status !== 'PENDING') throw notPending(req.status);
      await tx.overtimeRequest.update({ where: { id }, data: { status: 'CANCELLED', decidedAt: now } });
      await this.audit.record(tx, {
        actorUserId: user.userId, action: 'OVERTIME_REQUEST_CANCEL', entityType: 'OvertimeRequest', entityId: id, ipAddress: user.ip,
        before: { status: 'PENDING' }, after: { status: 'CANCELLED' },
      });
    }, TX_OPTIONS);
    return this.get(id);
  }

  async decide(user: AuthUser, id: string, decision: 'APPROVED' | 'REJECTED', comment: string | undefined): Promise<OvertimeRequestDto> {
    const approver = approverFor(user, P.OVERTIME_APPROVE);
    const note = comment?.trim() || null;
    if (decision === 'REJECTED' && !note) throw invalidField('comment', 'A reason is required to reject a request');
    const existing = await this.prisma.overtimeRequest.findUnique({ where: { id }, include: OVERTIME_INCLUDE });
    if (!existing) throw AppError.notFound('Overtime request not found');
    assertMayDecide(approver, existing.employeeId, existing.employee.departmentId, approver !== null && canDecideSingle(approver, { employeeId: existing.employeeId, departmentId: existing.employee.departmentId }));
    const today = localDate(new Date());
    const workDate = dateOnly.fromDb(existing.workDate);
    const recorded = workDate < today
      ? (await this.recordedExtra([existing], new Map([[existing.employeeId, existing.employee]]), today)).get(`${existing.employeeId}|${workDate}`) ?? 0
      : null;

    await this.prisma.$transaction(async (tx) => {
      const now = await lockEmployee(tx, existing.employeeId);
      const req = await tx.overtimeRequest.findUniqueOrThrow({ where: { id } });
      if (req.status !== 'PENDING') throw notPending(req.status);
      const approvedMinutes = decision === 'APPROVED' ? approvedOvertimeMinutes(req.minutes, recorded) : null;
      await tx.overtimeApproval.create({ data: { requestId: id, approverUserId: user.userId, level: 1, decision, comment: note } });
      await tx.overtimeRequest.update({ where: { id }, data: { status: decision, decidedAt: now, approvedMinutes } });
      await this.audit.record(tx, {
        actorUserId: user.userId, action: decision === 'APPROVED' ? 'OVERTIME_REQUEST_APPROVE' : 'OVERTIME_REQUEST_REJECT',
        entityType: 'OvertimeRequest', entityId: id, ipAddress: user.ip,
        before: { status: 'PENDING', minutes: req.minutes },
        after: { status: decision, approvedMinutes, recordedExtraMinutes: recorded, multiplier: req.multiplier?.toString() ?? null, comment: note },
      });
      const recipient = await tx.user.findFirst({ where: { employeeId: req.employeeId, isActive: true }, select: { id: true } });
      if (recipient) {
        const type = decision === 'APPROVED' ? REQUEST_NOTIFICATION_TYPES.APPROVED : REQUEST_NOTIFICATION_TYPES.REJECTED;
        await this.notifications.notify(recipient.id, {
          type, title: decision === 'APPROVED' ? 'Overtime request approved' : 'Overtime request rejected', body: note ?? '',
          data: { type, kind: 'OVERTIME', requestId: id, workDate, minutes: req.minutes, approvedMinutes, comment: note },
        }, tx);
      }
    }, TX_OPTIONS);
    return this.get(id);
  }


  // ───────────── Direct approval (no request from the employee) ─────────────

  /**
   * Days on which employees in the approver's scope worked beyond their requirement (calc.ts extra
   * minutes, at least the policy minimum), with what is already approved or pending for that day.
   * Days that have not ended are left out.
   */
  async candidates(user: AuthUser, q: { from?: string; to?: string; departmentId?: string; employeeId?: string }): Promise<OvertimeCandidateDto[]> {
    const approver = approverFor(user, P.OVERTIME_APPROVE);
    if (!approver) throw AppError.forbidden();
    const today = localDate(new Date());
    const yesterday = addDays(today, -1);
    const { from, to: rawTo } = resolveRange(q.from, q.to ?? yesterday, MAX_DAYS_BACK);
    const to = rawTo > yesterday ? yesterday : rawTo;
    if (to < from) return [];
    const employees = await this.prisma.employee.findMany({
      where: {
        isActive: true, deletedAt: null,
        ...(q.employeeId ? { id: q.employeeId } : {}),
        ...(q.departmentId ? { departmentId: q.departmentId } : {}),
        ...(approver.companyWide ? {} : { departmentId: { in: approver.departmentIds.filter((d) => !q.departmentId || d === q.departmentId) } }),
      },
      select: EMPLOYEE_REF_SELECT,
      orderBy: { fullName: 'asc' },
    });
    if (!employees.length) return [];
    const [{ days, context }, requests, policy] = await Promise.all([
      this.metrics.computeRange(employees, from, to),
      this.prisma.overtimeRequest.findMany({
        where: { employeeId: { in: employees.map((e) => e.id) }, workDate: { gte: dateOnly.toDb(from), lte: dateOnly.toDb(to) }, status: { in: ['PENDING', 'APPROVED'] } },
        select: { id: true, employeeId: true, workDate: true, status: true, minutes: true, approvedMinutes: true },
      }),
      this.defaultPolicy(),
    ]);
    const byDay = new Map(requests.map((r) => [`${r.employeeId}|${dateOnly.fromDb(r.workDate)}`, r]));
    const out: OvertimeCandidateDto[] = [];
    for (const e of employees) {
      for (const d of days.get(e.id) ?? []) {
        const r = byDay.get(`${e.id}|${d.workDate}`);
        // A few minutes past the end of the day are not overtime (below the policy minimum), unless already requested.
        if (d.extraMinutes < policy.minimumMinutes && !r) continue;
        const resolved = context.day(e, d.workDate);
        out.push({
          employee: toEmployeeRef(e), workDate: d.workDate, kind: overtimeKind(resolved.rule.isWorkday, resolved.isHoliday),
          extraMinutes: d.extraMinutes, firstIn: d.firstIn, lastOut: d.lastOut,
          request: r ? { id: r.id, status: r.status as 'PENDING' | 'APPROVED', minutes: r.minutes, approvedMinutes: r.approvedMinutes } : null,
          canApprove: e.id !== user.employeeId && r?.status !== 'APPROVED',
        });
      }
    }
    return out.sort((a, b) => b.workDate.localeCompare(a.workDate) || a.employee.fullName.localeCompare(b.employee.fullName));
  }

  /**
   * Approves overtime for chosen days without a request from the employee. Each day becomes an
   * APPROVED overtime request (requester = approver) at the policy's current multiplier, capped at the
   * extra time recorded for past days; a pending request for the day is approved instead. Days are
   * saved one by one and reported individually.
   */
  async approveDirect(user: AuthUser, input: DirectOvertimeInput): Promise<DirectOvertimeResultDto> {
    const approver = approverFor(user, P.OVERTIME_APPROVE);
    if (!approver) throw AppError.forbidden();
    const policy = await this.defaultPolicy();
    const today = localDate(new Date());
    const note = input.comment?.trim() || null;
    const results: DirectOvertimeResultDto['results'] = [];
    for (const item of input.items) {
      try {
        const workDate = assertDate(item.workDate, 'workDate');
        const employee = await this.prisma.employee.findFirst({ where: { id: item.employeeId, deletedAt: null }, select: EMPLOYEE_REF_SELECT });
        if (!employee) throw AppError.notFound('Employee not found');
        if (employee.id === user.employeeId) throw AppError.forbidden('SELF_APPROVAL_FORBIDDEN', 'You cannot approve your own overtime');
        if (!canDecideSingle(approver, { employeeId: employee.id, departmentId: employee.departmentId })) {
          throw AppError.forbidden('APPROVAL_NOT_ALLOWED', 'This employee is outside your approval scope');
        }
        if (workDate > addDays(today, MAX_DAYS_AHEAD) || workDate < addDays(today, -MAX_DAYS_BACK)) throw invalidField('workDate', 'workDate is out of range');
        const recorded = workDate < today
          ? (await this.recordedExtra([{ employeeId: employee.id, workDate: dateOnly.toDb(workDate) }], new Map([[employee.id, employee]]), today)).get(`${employee.id}|${workDate}`) ?? 0
          : null;
        const minutes = item.minutes ?? recorded ?? 0;
        if (minutes < policy.minimumMinutes) {
          throw AppError.badRequest('OVERTIME_BELOW_MINIMUM', `Overtime starts at ${policy.minimumMinutes} minutes`, { minimumMinutes: policy.minimumMinutes, recordedExtraMinutes: recorded });
        }
        const approvedMinutes = approvedOvertimeMinutes(minutes, recorded);
        const resolved = (await this.resolver.load([employee], workDate, workDate)).day(employee, workDate);
        const kind = overtimeKind(resolved.rule.isWorkday, resolved.isHoliday);
        const id = await this.prisma.$transaction(async (tx) => {
          const now = await lockEmployee(tx, employee.id);
          const existing = await tx.overtimeRequest.findFirst({ where: { employeeId: employee.id, workDate: dateOnly.toDb(workDate), status: { in: ['PENDING', 'APPROVED'] } } });
          if (existing?.status === 'APPROVED') throw AppError.conflict('DUPLICATE_REQUEST', 'Overtime is already approved for this day', { requestId: existing.id });
          const row = existing
            ? await tx.overtimeRequest.update({ where: { id: existing.id }, data: { status: 'APPROVED', decidedAt: now, approvedMinutes, compensation: input.compensation ?? existing.compensation } })
            : await tx.overtimeRequest.create({
                data: {
                  employeeId: employee.id, workDate: dateOnly.toDb(workDate), minutes, kind, compensation: input.compensation ?? 'PAY',
                  isPreApproval: workDate >= today, reason: note ?? 'Approved by a manager without a request', policyId: policy.id,
                  multiplier: multiplierFor(policy, kind), status: 'APPROVED', decidedAt: now, approvedMinutes,
                },
              });
          await tx.overtimeApproval.create({ data: { requestId: row.id, approverUserId: user.userId, level: 1, decision: 'APPROVED', comment: note } });
          await this.audit.record(tx, {
            actorUserId: user.userId, action: existing ? 'OVERTIME_REQUEST_APPROVE' : 'OVERTIME_DIRECT_APPROVE', entityType: 'OvertimeRequest', entityId: row.id,
            ipAddress: user.ip,
            after: { employeeId: employee.id, workDate, minutes, approvedMinutes, recordedExtraMinutes: recorded, kind, multiplier: row.multiplier?.toString() ?? null, comment: note, direct: !existing },
          });
          const recipient = await tx.user.findFirst({ where: { employeeId: employee.id, isActive: true }, select: { id: true } });
          if (recipient) {
            await this.notifications.notify(recipient.id, {
              type: REQUEST_NOTIFICATION_TYPES.APPROVED, title: 'Overtime approved', body: note ?? `${approvedMinutes} minutes of overtime approved for ${workDate}.`,
              data: { type: REQUEST_NOTIFICATION_TYPES.APPROVED, kind: 'OVERTIME', requestId: row.id, workDate, minutes, approvedMinutes, comment: note, directOvertime: !existing },
            }, tx);
          }
          return row.id;
        }, TX_OPTIONS);
        results.push({ employeeId: item.employeeId, workDate, ok: true, requestId: id, approvedMinutes, error: null });
      } catch (e) {
        results.push({ employeeId: item.employeeId, workDate: item.workDate, ok: false, requestId: null, approvedMinutes: null, error: e instanceof AppError ? e.code : 'INTERNAL_ERROR' });
      }
    }
    return { approved: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  }

  canAct(approver: Approver | null, row: OvertimeRow): boolean {
    return approver !== null && row.status === 'PENDING' && canDecideSingle(approver, { employeeId: row.employeeId, departmentId: row.employee.departmentId });
  }

  // ───────────── Reads ─────────────

  async get(id: string): Promise<OvertimeRequestDto> {
    const row = await this.prisma.overtimeRequest.findUnique({ where: { id }, include: OVERTIME_INCLUDE });
    if (!row) throw AppError.notFound('Overtime request not found');
    return (await this.toDtos(this.prisma, [row]))[0];
  }

  async mine(user: AuthUser, q: { status?: string }): Promise<OvertimeRequestDto[]> {
    const employeeId = requireEmployee(user);
    const rows = await this.prisma.overtimeRequest.findMany({
      where: { employeeId, ...(q.status ? { status: q.status as RequestStatus } : {}) },
      include: OVERTIME_INCLUDE, orderBy: { workDate: 'desc' }, take: 200,
    });
    return this.toDtos(this.prisma, rows);
  }

  async toDtos(db: Db, rows: OvertimeRow[]): Promise<OvertimeRequestDto[]> {
    const today = localDate(new Date());
    const [steps, recorded, policy] = await Promise.all([
      approvalStepsByRequest(db, rows.flatMap((r) => r.approvals)),
      this.recordedExtra(rows, new Map(rows.map((r) => [r.employeeId, r.employee])), today),
      rows.some((r) => r.multiplier === null) ? this.defaultPolicy(db) : Promise.resolve(null),
    ]);
    return rows.map((r) => {
      const workDate = dateOnly.fromDb(r.workDate);
      const kind = r.kind as OvertimeKind;
      const multiplier = r.multiplier ? normalizeMultiplier(r.multiplier.toString()) : multiplierFor(policy!, kind);
      const baseMinutes = r.approvedMinutes ?? r.minutes;
      return {
        id: r.id,
        employee: toEmployeeRef(r.employee),
        workDate,
        minutes: r.minutes,
        approvedMinutes: r.approvedMinutes,
        recordedExtraMinutes: recorded.get(`${r.employeeId}|${workDate}`) ?? null,
        kind,
        compensation: r.compensation as OvertimeCompensation,
        isPreApproval: r.isPreApproval,
        reason: r.reason,
        status: r.status,
        estimate: { baseMinutes, multiplier, compensatedMinutes: compensatedMinutes(baseMinutes, multiplier) },
        createdAt: r.createdAt.toISOString(),
        decidedAt: r.decidedAt?.toISOString() ?? null,
        approvals: steps.get(r.id) ?? [],
      };
    });
  }

  static readonly include = OVERTIME_INCLUDE;
}
