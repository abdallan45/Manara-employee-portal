import { Injectable } from '@nestjs/common';
import { Prisma, type LeaveType, type RequestStatus } from '@prisma/client';
import {
  LEAVE_MODES_BY_UNIT, PERMISSIONS, REQUEST_NOTIFICATION_TYPES,
  type CreateLeaveRequestInput, type LeaveBalanceDto, type LeaveLedgerEntryDto, type LeaveLedgerKind, type LeavePreviewDto, type LeaveRequestDto,
  type LeaveTypeDto, type LeaveUnit,
} from '@workforce/shared';
import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../common/auth';
import { PrismaService, type Db } from '../../common/prisma.service';
import { dateOnly, localDate } from '../../common/time';
import { assertDate, daySpan } from '../attendance/date-range';
import { leaveDates } from '../attendance/leave-days';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { ScheduleResolver, type EmployeeRef } from '../schedules/schedule-resolver';
import { approverFor, canDecideStep, coversEmployee, parseSteps, skippedLevels, stepAt, type Approver, type RoutedRequest } from './approval-routing';
import {
  accrualDue, accrualMode, carryoverMinutes, computeLeaveSpan, monthlyAccruals, monthsDue, summarizeLedger, tracksBalance, yearlyAccrual, type LeaveSpan,
} from './leave-math';
import {
  ApproverDirectory, approvalStepsByRequest, assertMayDecide, assertStepAllowed, EMPLOYEE_REF_SELECT, invalidField, lockEmployee, notPending,
  priorApprovers, requireEmployee, toEmployeeRef, TX_OPTIONS, type EmployeeRefRow,
} from './request-common';

const P = PERMISSIONS;
const MAX_FULL_DAY_SPAN = 60;

const LEAVE_INCLUDE = {
  leaveType: true,
  employee: { select: EMPLOYEE_REF_SELECT },
  approvals: true,
  // Metadata only: file contents are loaded by LeaveDocumentsService when opened.
  documents: { select: { id: true, fileName: true, mimeType: true, size: true, createdAt: true, uploadedById: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.LeaveRequestInclude;
export type LeaveRow = Prisma.LeaveRequestGetPayload<{ include: typeof LEAVE_INCLUDE }>;

export const leaveTypeToDto = (t: LeaveType): LeaveTypeDto => ({
  id: t.id, code: t.code, name: t.name, nameAr: t.nameAr, isPaid: t.isPaid,
  unit: t.unit as LeaveUnit, accrual: t.accrual as LeaveTypeDto['accrual'],
  annualEntitlementMinutes: t.annualEntitlementMinutes, carryoverMaxMinutes: t.carryoverMaxMinutes,
  requiresAttachment: t.requiresAttachment, approvalSteps: parseSteps(t.approvalSteps), isSensitive: t.isSensitive,
  isRemoteWork: t.isRemoteWork, tracksBalance: tracksBalance(t), isActive: t.isActive,
});

const yearOf = (date: string) => Number(date.slice(0, 4));

/** Note prefix of ACCRUAL rows posted by reconcileEntitlement: `entitlement:<minutes>[\n<reason>]`. */
const ENTITLEMENT_NOTE = 'entitlement:';

/** Turns a ledger row into the history entry the employee page shows (kind, reason, period). */
export function toLedgerEntry(
  r: { id: string; createdAt: Date; leaveTypeId: string; year: number; kind: string; minutes: number; note: string | null; requestId: string | null; createdById: string | null },
  usernames: Map<string, string>,
): LeaveLedgerEntryDto {
  const note = r.note ?? '';
  let kind = r.kind as LeaveLedgerKind;
  let reason: string | null = null;
  let period: string | null = null;
  if (r.kind === 'ACCRUAL' && note.startsWith(ENTITLEMENT_NOTE)) {
    kind = 'ENTITLEMENT_CORRECTION';
    const nl = note.indexOf('\n');
    reason = nl >= 0 ? note.slice(nl + 1).trim() || null : null;
  } else if (r.kind === 'ACCRUAL') {
    period = /^(?:year|month):(.+)$/.exec(note)?.[1] ?? null;
  } else if (r.kind === 'CARRYOVER') {
    period = /^from:(.+)$/.exec(note)?.[1] ?? null;
  } else {
    reason = r.note?.trim() || null;
  }
  const username = r.createdById ? usernames.get(r.createdById) : undefined;
  return {
    id: r.id, createdAt: r.createdAt.toISOString(), leaveTypeId: r.leaveTypeId, year: r.year, kind, minutes: r.minutes,
    note: reason, period, requestId: r.requestId, actor: username ? { username } : null,
  };
}

/**
 * HR may not change their own leave balance or entitlement (that is self-dealing, like approving
 * their own request): another HR member has to. Bulk calls are rejected as a whole.
 */
export function assertNotOwnBalance(user: AuthUser, employeeIds: string[], what: 'adjust' | 'entitlement'): void {
  if (!user.employeeId || !employeeIds.includes(user.employeeId)) return;
  throw AppError.forbidden(
    'SELF_APPROVAL_FORBIDDEN',
    what === 'adjust'
      ? 'You cannot adjust your own leave balance; ask another HR member'
      : 'You cannot change your own leave entitlement; ask another HR member',
    { employeeId: user.employeeId },
  );
}

export interface LeaveViewer {
  userId: string;
  employeeId: string | null;
  /** HR / admin view: sensitive types are shown in full. */
  companyWide: boolean;
}

@Injectable()
export class LeaveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly resolver: ScheduleResolver,
    private readonly notifications: NotificationService,
    private readonly directory: ApproverDirectory,
  ) {}

  // ───────────── Balances ─────────────

  /** The employee's own entitlement for the year (latest fromYear not after it), else the type's default. */
  async entitlementFor(db: Db, employeeId: string, type: LeaveType, year: number): Promise<number> {
    const own = await db.leaveEntitlement.findFirst({
      where: { employeeId, leaveTypeId: type.id, fromYear: { lte: year } },
      orderBy: { fromYear: 'desc' },
      select: { annualEntitlementMinutes: true },
    });
    return own?.annualEntitlementMinutes ?? type.annualEntitlementMinutes;
  }

  /**
   * After an entitlement change, brings every already-opened year from `fromYear` on in line: posts the
   * difference between what the accrual schedule owes with the current entitlement and what was
   * accrued so far (an ACCRUAL row noted `entitlement`). Years not opened yet use it when they open.
   * Must run inside a transaction holding the employee lock.
   */
  async reconcileEntitlement(tx: Prisma.TransactionClient, employee: { id: string; hireDate: Date | null }, type: LeaveType, fromYear: number, actorUserId: string, today: string): Promise<number> {
    if (!tracksBalance(type)) return 0;
    const hireDate = employee.hireDate ? dateOnly.fromDb(employee.hireDate) : null;
    const opened = await tx.leaveBalance.findMany({ where: { employeeId: employee.id, leaveTypeId: type.id, year: { gte: fromYear } }, select: { year: true } });
    // The reason HR gave for the entitlement starting at fromYear (none when it was just removed) goes
    // into the correction rows, so the ledger history says why the balance changed.
    const source = await tx.leaveEntitlement.findUnique({
      where: { employeeId_leaveTypeId_fromYear: { employeeId: employee.id, leaveTypeId: type.id, fromYear } },
      select: { note: true },
    });
    const reason = source?.note?.trim() || null;
    let posted = 0;
    for (const { year } of opened) {
      const entitlement = await this.entitlementFor(tx, employee.id, type, year);
      const due = accrualDue(accrualMode(type), entitlement, year, hireDate, today);
      const sum = await tx.leaveTransaction.aggregate({ where: { employeeId: employee.id, leaveTypeId: type.id, year, kind: 'ACCRUAL' }, _sum: { minutes: true } });
      const delta = due - (sum._sum.minutes ?? 0);
      if (delta === 0) continue;
      await tx.leaveTransaction.create({
        data: {
          employeeId: employee.id, leaveTypeId: type.id, year, minutes: delta, kind: 'ACCRUAL',
          note: `${ENTITLEMENT_NOTE}${entitlement}${reason ? `\n${reason}` : ''}`, createdById: actorUserId,
        },
      });
      posted++;
    }
    return posted;
  }

  /**
   * Lazily writes the ledger rows a year needs: a header, the carryover from the previous year
   * (capped, only when that year was opened), and the yearly grant or the monthly accruals due so far.
   * Must run inside a transaction holding the employee lock.
   */
  async ensureYear(tx: Prisma.TransactionClient, employee: { id: string; hireDate: Date | null }, type: LeaveType, year: number, today: string): Promise<void> {
    if (!tracksBalance(type)) return;
    const key = { employeeId_leaveTypeId_year: { employeeId: employee.id, leaveTypeId: type.id, year } };
    const hireDate = employee.hireDate ? dateOnly.fromDb(employee.hireDate) : null;
    const mode = accrualMode(type);
    const base = { employeeId: employee.id, leaveTypeId: type.id, year };
    const entitlement = await this.entitlementFor(tx, employee.id, type, year);

    if (!(await tx.leaveBalance.findUnique({ where: key }))) {
      await tx.leaveBalance.create({ data: base });
      const prevKey = { employeeId_leaveTypeId_year: { ...key.employeeId_leaveTypeId_year, year: year - 1 } };
      let carried = 0;
      if (type.carryoverMaxMinutes > 0 && (await tx.leaveBalance.findUnique({ where: prevKey }))) {
        const prev = await tx.leaveTransaction.aggregate({ where: { ...base, year: year - 1 }, _sum: { minutes: true } });
        carried = carryoverMinutes(prev._sum.minutes ?? 0, type.carryoverMaxMinutes);
        if (carried > 0) await tx.leaveTransaction.create({ data: { ...base, minutes: carried, kind: 'CARRYOVER', note: `from:${year - 1}` } });
      }
      let granted = 0;
      if (mode === 'YEARLY') {
        granted = yearlyAccrual(entitlement, year, hireDate);
        if (granted > 0) await tx.leaveTransaction.create({ data: { ...base, minutes: granted, kind: 'ACCRUAL', note: `year:${year}` } });
      }
      await this.audit.record(tx, {
        actorUserId: null, action: 'LEAVE_BALANCE_OPEN', entityType: 'LeaveBalance', entityId: `${employee.id}:${type.code}:${year}`,
        after: { employeeId: employee.id, leaveType: type.code, year, carriedOver: carried, granted, accrual: mode, entitlement },
      });
    }

    if (mode === 'MONTHLY') {
      const due = monthlyAccruals(entitlement, year, hireDate, monthsDue(year, today));
      if (!due.length) return;
      const existing = await tx.leaveTransaction.findMany({ where: { ...base, kind: 'ACCRUAL' }, select: { note: true } });
      const have = new Set(existing.map((e) => e.note));
      const missing = due.filter((d) => !have.has(`month:${d.month}`));
      if (missing.length) {
        await tx.leaveTransaction.createMany({ data: missing.map((d) => ({ ...base, minutes: d.minutes, kind: 'ACCRUAL', note: `month:${d.month}` })) });
      }
    }
  }

  private async balanceOf(db: Db, employeeId: string, type: LeaveType, year: number): Promise<LeaveBalanceDto> {
    const yearStart = new Date(`${year - 1}-12-31T00:00:00.000Z`); // generous bounds, filtered by local year below
    const yearEnd = new Date(`${year + 1}-01-02T00:00:00.000Z`);
    const [rows, pending] = await Promise.all([
      db.leaveTransaction.findMany({ where: { employeeId, leaveTypeId: type.id, year }, select: { minutes: true, kind: true } }),
      db.leaveRequest.findMany({
        where: { employeeId, leaveTypeId: type.id, status: 'PENDING', startAt: { gte: yearStart, lt: yearEnd } },
        select: { startAt: true, minutes: true },
      }),
    ]);
    const s = summarizeLedger(rows);
    const held = pending.filter((p) => yearOf(localDate(p.startAt)) === year).reduce((sum, p) => sum + p.minutes, 0);
    return { leaveType: leaveTypeToDto(type), year, ...s, pending: held, available: s.balance - held };
  }

  /** Balances of every active type that keeps one; opens the year on first access. */
  async balances(employeeId: string, year: number, viewer: LeaveViewer): Promise<LeaveBalanceDto[]> {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw invalidField('year', 'year must be between 2000 and 2100');
    const types = (await this.prisma.leaveType.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }))
      .filter((t) => tracksBalance(t))
      .filter((t) => !t.isSensitive || viewer.companyWide || viewer.employeeId === employeeId);
    const today = localDate(new Date());
    return this.prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employeeId);
      const employee = await tx.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { id: true, hireDate: true } });
      const out: LeaveBalanceDto[] = [];
      for (const t of types) {
        await this.ensureYear(tx, employee, t, year, today);
        out.push(await this.balanceOf(tx, employeeId, t, year));
      }
      return out;
    }, TX_OPTIONS);
  }

  /**
   * The leave ledger of one employee for a year, newest first: accruals, carryover, HR adjustments,
   * entitlement corrections, leave taken and cancellations, with who posted them. Opens the year like
   * balances() does, so both show the same rows. Sensitive types follow the same rule as balances().
   */
  async ledger(employeeId: string, year: number, viewer: LeaveViewer): Promise<LeaveLedgerEntryDto[]> {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw invalidField('year', 'year must be between 2000 and 2100');
    const types = (await this.prisma.leaveType.findMany({ orderBy: { name: 'asc' } }))
      .filter((t) => !t.isSensitive || viewer.companyWide || viewer.employeeId === employeeId);
    if (!types.length) return [];
    const today = localDate(new Date());
    const rows = await this.prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employeeId);
      const employee = await tx.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { id: true, hireDate: true } });
      for (const t of types) if (t.isActive && tracksBalance(t)) await this.ensureYear(tx, employee, t, year, today);
      return tx.leaveTransaction.findMany({
        where: { employeeId, year, leaveTypeId: { in: types.map((t) => t.id) } },
        // Rows of one transaction share createdAt; kind desc puts USAGE / ADJUSTMENT above the accrual opened with them.
        orderBy: [{ createdAt: 'desc' }, { kind: 'desc' }],
      });
    }, TX_OPTIONS);
    const actorIds = [...new Set(rows.map((r) => r.createdById).filter((id): id is string => !!id))];
    const users = actorIds.length ? await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, username: true } }) : [];
    const usernames = new Map(users.map((u) => [u.id, u.username]));
    return rows.map((r) => toLedgerEntry(r, usernames));
  }

  /** Throws unless `user` may see this employee's leave (self, or an approver whose scope covers them). */
  async assertCanView(user: AuthUser, employeeId: string): Promise<LeaveViewer> {
    const viewer = { userId: user.userId, employeeId: user.employeeId, companyWide: user.permissions.has(P.ATTENDANCE_READ_ALL) };
    if (employeeId === user.employeeId) return viewer;
    const approver = approverFor(user, P.LEAVE_APPROVE);
    const employee = await this.prisma.employee.findFirst({ where: { id: employeeId, deletedAt: null }, select: { departmentId: true } });
    if (!employee) throw AppError.notFound('Employee not found');
    // Out of scope answers like a missing employee, so ids outside the scope cannot be probed.
    if (!approver || !coversEmployee(approver, { employeeId, departmentId: employee.departmentId })) throw AppError.notFound('Employee not found');
    return { ...viewer, companyWide: approver.companyWide };
  }

  /** HR ledger adjustment (opening balances, corrections); positive credits, negative debits. */
  async adjust(user: AuthUser, input: { employeeId: string; leaveTypeId: string; year: number; minutes: number; note: string }): Promise<LeaveBalanceDto> {
    const approver = approverFor(user, P.LEAVE_APPROVE);
    if (!approver?.companyWide) throw AppError.forbidden('FORBIDDEN', 'Only HR can adjust leave balances');
    assertNotOwnBalance(user, [input.employeeId], 'adjust');
    if (input.minutes === 0) throw invalidField('minutes', 'minutes must not be zero');
    const type = await this.prisma.leaveType.findUnique({ where: { id: input.leaveTypeId } });
    if (!type) throw AppError.notFound('Leave type not found');
    if (!tracksBalance(type)) throw invalidField('leaveTypeId', 'This leave type does not keep a balance');
    const today = localDate(new Date());
    return this.prisma.$transaction(async (tx) => {
      await lockEmployee(tx, input.employeeId);
      const employee = await tx.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: { id: true, hireDate: true } });
      await this.ensureYear(tx, employee, type, input.year, today);
      const row = await tx.leaveTransaction.create({
        data: { employeeId: employee.id, leaveTypeId: type.id, year: input.year, minutes: input.minutes, kind: 'ADJUSTMENT', note: input.note, createdById: user.userId },
      });
      await this.audit.record(tx, {
        actorUserId: user.userId, action: 'LEAVE_BALANCE_ADJUST', entityType: 'LeaveTransaction', entityId: row.id, ipAddress: user.ip,
        after: { employeeId: employee.id, leaveType: type.code, year: input.year, minutes: input.minutes, note: input.note },
      });
      return this.balanceOf(tx, employee.id, type, input.year);
    }, TX_OPTIONS);
  }

  // ───────────── Requests ─────────────

  private async activeType(leaveTypeId: string): Promise<LeaveType> {
    const type = await this.prisma.leaveType.findUnique({ where: { id: leaveTypeId } });
    if (!type) throw AppError.notFound('Leave type not found');
    if (!type.isActive) throw AppError.conflict('LEAVE_TYPE_INACTIVE', 'This leave type is not active', { leaveTypeId });
    return type;
  }

  private async span(employee: EmployeeRef, type: LeaveType, input: CreateLeaveRequestInput): Promise<LeaveSpan> {
    const allowed = LEAVE_MODES_BY_UNIT[type.unit as LeaveUnit] ?? ['FULL_DAY'];
    if (!allowed.includes(input.mode)) throw invalidField('mode', `${type.code} allows ${allowed.join(', ')}`);
    const startDate = assertDate(input.startDate, 'startDate');
    const endDate = input.mode === 'FULL_DAY' ? assertDate(input.endDate ?? startDate, 'endDate') : startDate;
    if (endDate < startDate) throw invalidField('endDate', 'endDate must not be before startDate');
    if (yearOf(startDate) !== yearOf(endDate)) throw invalidField('endDate', 'A request cannot span two calendar years; split it at 31 December');
    if (daySpan(startDate, endDate) > MAX_FULL_DAY_SPAN) throw invalidField('endDate', `A request may cover at most ${MAX_FULL_DAY_SPAN} days`);
    const context = await this.resolver.load([employee], startDate, endDate);
    return computeLeaveSpan({ ...input, startDate, endDate }, (d) => {
      const r = context.day(employee, d);
      return { isWorkday: r.rule.isWorkday, isHoliday: r.isHoliday, requiredMinutes: r.rule.requiredMinutes, startMinute: r.rule.startMinute, endMinute: r.rule.endMinute };
    });
  }

  private overlapping(db: Db, employeeId: string, span: { startAt: Date; endAt: Date }) {
    return db.leaveRequest.findMany({
      where: { employeeId, status: { in: ['PENDING', 'APPROVED'] }, startAt: { lt: span.endAt }, endAt: { gt: span.startAt } },
      select: { id: true, startAt: true, endAt: true, status: true },
    });
  }

  private async selfEmployee(user: AuthUser) {
    const employeeId = requireEmployee(user);
    const employee = await this.prisma.employee.findFirst({ where: { id: employeeId, isActive: true, deletedAt: null }, select: EMPLOYEE_REF_SELECT });
    if (!employee) throw AppError.forbidden('NOT_AN_EMPLOYEE', 'No active employee record');
    return employee;
  }

  async preview(user: AuthUser, input: CreateLeaveRequestInput): Promise<LeavePreviewDto> {
    const employee = await this.selfEmployee(user);
    const type = await this.activeType(input.leaveTypeId);
    const span = await this.span(employee, type, input);
    const overlaps = await this.overlapping(this.prisma, employee.id, span);
    let available: number | null = null;
    if (tracksBalance(type)) {
      const [balance] = (await this.balances(employee.id, yearOf(input.startDate), { userId: user.userId, employeeId: employee.id, companyWide: false }))
        .filter((b) => b.leaveType.id === type.id);
      available = balance?.available ?? 0;
    }
    return {
      minutes: span.minutes, workdays: span.workdays, startAt: span.startAt.toISOString(), endAt: span.endAt.toISOString(),
      available, sufficient: available === null || span.minutes <= available,
      overlaps: overlaps.map((o) => ({ id: o.id, ...leaveDates(o), status: o.status })),
    };
  }

  async create(user: AuthUser, input: CreateLeaveRequestInput): Promise<LeaveRequestDto> {
    const employee = await this.selfEmployee(user);
    const type = await this.activeType(input.leaveTypeId);
    const span = await this.span(employee, type, input);
    const year = yearOf(input.startDate);
    const today = localDate(new Date());

    const id = await this.prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employee.id);
      const overlaps = await this.overlapping(tx, employee.id, span);
      if (overlaps.length) {
        throw AppError.conflict('LEAVE_OVERLAP', 'This request overlaps another leave request', {
          requests: overlaps.map((o) => ({ id: o.id, ...leaveDates(o), status: o.status })),
        });
      }
      if (tracksBalance(type)) {
        await this.ensureYear(tx, employee, type, year, today);
        const balance = await this.balanceOf(tx, employee.id, type, year);
        if (span.minutes > balance.available) {
          throw AppError.conflict('LEAVE_BALANCE_INSUFFICIENT', 'Not enough leave balance for this request', { available: balance.available, requested: span.minutes });
        }
      }
      const chain = await this.directory.start(P.LEAVE_APPROVE, parseSteps(type.approvalSteps), employee, { skipManager: type.isSensitive }, tx);
      const row = await tx.leaveRequest.create({
        data: {
          employeeId: employee.id, leaveTypeId: type.id, mode: input.mode, startAt: span.startAt, endAt: span.endAt,
          minutes: span.minutes, reason: input.reason.trim(), currentLevel: chain.level, approvalSteps: chain.steps,
        },
      });
      await this.audit.record(tx, {
        actorUserId: user.userId, action: 'LEAVE_REQUEST_CREATE', entityType: 'LeaveRequest', entityId: row.id, ipAddress: user.ip,
        after: {
          employeeId: employee.id, leaveType: type.code, mode: input.mode, startAt: span.startAt.toISOString(), endAt: span.endAt.toISOString(),
          minutes: span.minutes, currentLevel: chain.level, approvalSteps: chain.steps,
        },
      });
      await this.notifyApprovers(tx, row.id, employee, type, chain.level, chain.recipients);
      return row.id;
    }, TX_OPTIONS);
    return this.get(id, { userId: user.userId, employeeId: employee.id, companyWide: false });
  }

  private async notifyApprovers(tx: Prisma.TransactionClient, requestId: string, employee: EmployeeRefRow, type: LeaveType, level: number, recipients: string[]) {
    await this.notifications.notifyMany(recipients, {
      type: REQUEST_NOTIFICATION_TYPES.PENDING_APPROVAL,
      title: 'Leave request waiting for approval',
      body: `${employee.fullName} (${employee.employeeCode}) requested leave.`,
      data: {
        type: REQUEST_NOTIFICATION_TYPES.PENDING_APPROVAL, kind: 'LEAVE', requestId, level,
        employeeName: employee.fullName, employeeNameAr: employee.fullNameAr, employeeCode: employee.employeeCode,
        // Sensitive types never reach managers, but keep the type out of the payload anyway.
        leaveType: type.isSensitive ? null : type.code,
      },
      dedupeKey: `leave-pending:${requestId}:${level}`,
    }, tx);
  }

  async cancel(user: AuthUser, id: string): Promise<LeaveRequestDto> {
    const existing = await this.prisma.leaveRequest.findUnique({ where: { id }, include: { employee: { select: { departmentId: true } } } });
    if (!existing) throw AppError.notFound('Leave request not found');
    const own = existing.employeeId === user.employeeId;
    const hr = approverFor(user, P.LEAVE_APPROVE);
    if (!own && !hr?.companyWide) throw AppError.notFound('Leave request not found');

    await this.prisma.$transaction(async (tx) => {
      const now = await lockEmployee(tx, existing.employeeId);
      const req = await tx.leaveRequest.findUniqueOrThrow({ where: { id }, include: { leaveType: true } });
      if (req.status !== 'PENDING' && req.status !== 'APPROVED') throw notPending(req.status);
      // HR may cancel started leave of others, never their own (that would give them the days back).
      if (req.status === 'APPROVED' && req.startAt <= now && (own || !hr?.companyWide)) {
        const message = own && hr?.companyWide
          ? 'Your own leave has started; ask another HR member to cancel it'
          : 'Leave that has started can only be cancelled by HR';
        throw AppError.conflict('LEAVE_ALREADY_STARTED', message, { startAt: req.startAt.toISOString() });
      }
      await tx.leaveRequest.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: now } });
      let credited = 0;
      if (req.status === 'APPROVED' && tracksBalance(req.leaveType)) {
        // Give back exactly what the approval debited (the USAGE rows of this request).
        const debits = await tx.leaveTransaction.findMany({ where: { requestId: id, kind: 'USAGE' } });
        for (const d of debits) {
          await tx.leaveTransaction.create({
            data: { employeeId: d.employeeId, leaveTypeId: d.leaveTypeId, year: d.year, minutes: -d.minutes, kind: 'CANCELLATION', requestId: id, createdById: user.userId },
          });
          credited += -d.minutes;
        }
      }
      await this.audit.record(tx, {
        actorUserId: user.userId, action: 'LEAVE_REQUEST_CANCEL', entityType: 'LeaveRequest', entityId: id, ipAddress: user.ip,
        before: { status: req.status }, after: { status: 'CANCELLED', creditedMinutes: credited, byEmployee: own },
      });
    }, TX_OPTIONS);
    return this.get(id, { userId: user.userId, employeeId: user.employeeId, companyWide: hr?.companyWide ?? false });
  }

  /**
   * Approve or reject the step the request waits at. Approving a step that is not the last moves the
   * request to the next step somebody can decide (steps nobody can decide are passed over); approving
   * the last one approves the request and debits the balance. A rejection at any step ends it.
   */
  async decide(user: AuthUser, id: string, decision: 'APPROVED' | 'REJECTED', comment: string | undefined): Promise<LeaveRequestDto> {
    const approver = approverFor(user, P.LEAVE_APPROVE);
    const note = comment?.trim() || null;
    if (decision === 'REJECTED' && !note) throw invalidField('comment', 'A reason is required to reject a request');
    const existing = await this.prisma.leaveRequest.findUnique({ where: { id }, select: { employeeId: true } });
    if (!existing) throw AppError.notFound('Leave request not found');

    await this.prisma.$transaction(async (tx) => {
      const now = await lockEmployee(tx, existing.employeeId);
      const req = await tx.leaveRequest.findUniqueOrThrow({ where: { id }, include: LEAVE_INCLUDE });
      const routed = this.routed(req);
      assertMayDecide(approver, routed);
      if (req.status !== 'PENDING') throw notPending(req.status);
      assertStepAllowed(approver, routed, req.currentLevel);
      const steps = parseSteps(req.approvalSteps);
      const level = req.currentLevel;
      const step = routed.step!;
      await tx.leaveApproval.create({ data: { requestId: id, approverUserId: user.userId, level, step, decision, comment: note } });
      const recipient = await tx.user.findFirst({ where: { employeeId: req.employeeId, isActive: true }, select: { id: true } });
      const data = { kind: 'LEAVE', requestId: id, level, step, totalLevels: steps.length, leaveType: req.leaveType.code, startAt: req.startAt.toISOString(), comment: note };

      if (decision === 'REJECTED') {
        await tx.leaveRequest.update({ where: { id }, data: { status: 'REJECTED', rejectionReason: note, decidedAt: now } });
        await this.audit.record(tx, {
          actorUserId: user.userId, action: 'LEAVE_REQUEST_REJECT', entityType: 'LeaveRequest', entityId: id, ipAddress: user.ip,
          before: { status: 'PENDING', currentLevel: level }, after: { status: 'REJECTED', level, step, reason: note },
        });
        if (recipient) await this.notifications.notify(recipient.id, {
          type: REQUEST_NOTIFICATION_TYPES.REJECTED, title: 'Leave request rejected', body: note ?? '', data: { type: REQUEST_NOTIFICATION_TYPES.REJECTED, ...data },
        }, tx);
        return;
      }

      const exclude = [...routed.priorApproverIds, user.userId];
      const next = await this.directory.nextPosition(P.LEAVE_APPROVE, steps, level + 1, req.employee, exclude, { skipManager: req.leaveType.isSensitive }, tx);
      if (next) {
        await tx.leaveRequest.update({ where: { id }, data: { currentLevel: next.level } });
        await this.audit.record(tx, {
          actorUserId: user.userId, action: 'LEAVE_REQUEST_APPROVE_LEVEL', entityType: 'LeaveRequest', entityId: id, ipAddress: user.ip,
          before: { currentLevel: level, step }, after: { currentLevel: next.level, step: next.step, comment: note },
        });
        if (recipient) await this.notifications.notify(recipient.id, {
          type: REQUEST_NOTIFICATION_TYPES.LEVEL_APPROVED, title: `Leave request approved at step ${level} of ${steps.length}`,
          body: note ?? 'It now waits for the next approval.', data: { type: REQUEST_NOTIFICATION_TYPES.LEVEL_APPROVED, ...data, nextLevel: next.level, nextStep: next.step },
        }, tx);
        await this.notifyApprovers(tx, id, req.employee, req.leaveType, next.level, next.recipients);
        return;
      }

      await tx.leaveRequest.update({ where: { id }, data: { status: 'APPROVED', decidedAt: now } });
      if (tracksBalance(req.leaveType)) {
        const year = yearOf(localDate(req.startAt));
        await this.ensureYear(tx, req.employee, req.leaveType, year, localDate(now));
        await tx.leaveTransaction.create({
          data: { employeeId: req.employeeId, leaveTypeId: req.leaveTypeId, year, minutes: -req.minutes, kind: 'USAGE', requestId: id, createdById: user.userId },
        });
      }
      await this.audit.record(tx, {
        actorUserId: user.userId, action: 'LEAVE_REQUEST_APPROVE', entityType: 'LeaveRequest', entityId: id, ipAddress: user.ip,
        before: { status: 'PENDING', currentLevel: level }, after: { status: 'APPROVED', level, step, debitedMinutes: tracksBalance(req.leaveType) ? req.minutes : 0, comment: note },
      });
      if (recipient) await this.notifications.notify(recipient.id, {
        type: REQUEST_NOTIFICATION_TYPES.APPROVED, title: 'Leave request approved', body: note ?? '', data: { type: REQUEST_NOTIFICATION_TYPES.APPROVED, ...data },
      }, tx);
    }, TX_OPTIONS);
    return this.get(id, { userId: user.userId, employeeId: user.employeeId, companyWide: approver?.companyWide ?? false });
  }

  routed(req: LeaveRow): RoutedRequest {
    return {
      employeeId: req.employeeId, departmentId: req.employee.departmentId,
      step: req.status === 'PENDING' ? stepAt(parseSteps(req.approvalSteps), req.currentLevel) : null,
      priorApproverIds: priorApprovers(req.approvals),
    };
  }

  canAct(approver: Approver | null, req: LeaveRow): boolean {
    return approver !== null && canDecideStep(approver, this.routed(req));
  }

  // ───────────── Reads ─────────────

  async get(id: string, viewer: LeaveViewer): Promise<LeaveRequestDto> {
    const row = await this.prisma.leaveRequest.findUnique({ where: { id }, include: LEAVE_INCLUDE });
    if (!row) throw AppError.notFound('Leave request not found');
    return (await this.toDtos(this.prisma, [row], viewer))[0];
  }

  /** Own request, or one in the viewer's approval scope. */
  async getFor(user: AuthUser, id: string): Promise<LeaveRequestDto> {
    const row = await this.prisma.leaveRequest.findUnique({ where: { id }, select: { employeeId: true } });
    if (!row) throw AppError.notFound('Leave request not found');
    const viewer = await this.assertCanView(user, row.employeeId).catch(() => {
      throw AppError.notFound('Leave request not found');
    });
    return this.get(id, viewer);
  }

  async mine(user: AuthUser, q: { year?: number; status?: string }): Promise<LeaveRequestDto[]> {
    const employeeId = requireEmployee(user);
    const where: Prisma.LeaveRequestWhereInput = { employeeId };
    if (q.status) where.status = q.status as RequestStatus;
    if (q.year) where.startAt = { gte: new Date(`${q.year - 1}-12-31T00:00:00Z`), lt: new Date(`${q.year + 1}-01-02T00:00:00Z`) };
    const rows = await this.prisma.leaveRequest.findMany({ where, include: LEAVE_INCLUDE, orderBy: { startAt: 'desc' }, take: 200 });
    const filtered = q.year ? rows.filter((r) => yearOf(localDate(r.startAt)) === q.year) : rows;
    return this.toDtos(this.prisma, filtered, { userId: user.userId, employeeId, companyWide: false });
  }

  async toDtos(db: Db, rows: LeaveRow[], viewer: LeaveViewer): Promise<LeaveRequestDto[]> {
    const steps = await approvalStepsByRequest(db, rows.flatMap((r) => r.approvals));
    return rows.map((r) => {
      const confidential = r.leaveType.isSensitive && !viewer.companyWide && viewer.employeeId !== r.employeeId;
      const dates = leaveDates(r);
      return {
        id: r.id,
        employee: toEmployeeRef(r.employee),
        leaveType: confidential ? null : leaveTypeToDto(r.leaveType),
        confidential,
        mode: r.mode as LeaveRequestDto['mode'],
        startDate: dates.startDate,
        endDate: dates.endDate,
        startAt: r.startAt.toISOString(),
        endAt: r.endAt.toISOString(),
        minutes: r.minutes,
        reason: confidential ? null : r.reason,
        status: r.status,
        currentLevel: r.currentLevel,
        // The chain and HR's rejection reason can both identify a confidential type.
        approvalSteps: confidential ? null : parseSteps(r.approvalSteps),
        rejectionReason: confidential ? null : r.rejectionReason,
        createdAt: r.createdAt.toISOString(),
        decidedAt: r.decidedAt?.toISOString() ?? null,
        cancelledAt: r.cancelledAt?.toISOString() ?? null,
        approvals: confidential ? [] : steps.get(r.id) ?? [],
        skippedLevels: confidential ? [] : skippedLevels(r.status, r.currentLevel, parseSteps(r.approvalSteps).length, r.approvals),
        documents: confidential ? [] : r.documents.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() })),
      };
    });
  }

  static readonly include = LEAVE_INCLUDE;
}
