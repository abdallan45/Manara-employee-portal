import { Injectable } from '@nestjs/common';
import { Prisma, type RequestStatus, type WorkSession } from '@prisma/client';
import {
  PERMISSIONS, REQUEST_NOTIFICATION_TYPES,
  type CorrectableSessionDto, type CorrectionKind, type CorrectionRequestDto, type CreateCorrectionInput,
} from '@workforce/shared';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../common/auth';
import { PrismaService, type Db } from '../../common/prisma.service';
import { addDays, dateOnly, localDate } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { inetOrZero } from '../../common/ip';
import { NotificationService } from '../notifications/notification.service';
import { approverFor, canDecideSingle, type Approver } from './approval-routing';
import {
  ApproverDirectory, assertMayDecide, EMPLOYEE_REF_SELECT, invalidField, lockEmployee, notPending, parseInstant, requireEmployee,
  toEmployeeRef, TX_OPTIONS,
} from './request-common';

const P = PERMISSIONS;
const HOUR = 3_600_000;
const MAX_SESSION_HOURS = 24;
const CORRECTABLE_DAYS = 31;

const CORRECTION_INCLUDE = { employee: { select: EMPLOYEE_REF_SELECT } } satisfies Prisma.AttendanceCorrectionInclude;
export type CorrectionRow = Prisma.AttendanceCorrectionGetPayload<{ include: typeof CORRECTION_INCLUDE }>;

interface Proposal {
  kind: CorrectionKind;
  eventType: 'CHECK_IN' | 'CHECK_OUT';
  proposedTime: Date;
  proposedEndTime: Date | null;
  workSessionId: string | null;
}

const invalidCorrection = (message: string, details?: Record<string, unknown>) => AppError.conflict('CORRECTION_INVALID', message, details);

/**
 * Attendance correction requests. Approval never edits or deletes an attendance event: it appends
 * ADMIN_CORRECTION events and repairs the work session they belong to.
 */
@Injectable()
export class CorrectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly directory: ApproverDirectory,
  ) {}

  /**
   * Checks a proposal against the current attendance records. Used when the request is made and again,
   * under the employee lock, when it is approved (the records may have changed in between).
   */
  private async validate(db: Db, employeeId: string, p: Proposal, now: Date): Promise<WorkSession | null> {
    if (p.proposedTime > now || (p.proposedEndTime && p.proposedEndTime > now)) throw invalidField('proposedTime', 'A correction cannot be in the future');

    const others = (excludeId: string | null, from: Date, to: Date) =>
      db.workSession.findFirst({
        where: { employeeId, ...(excludeId ? { id: { not: excludeId } } : {}), startedAt: { lt: to }, OR: [{ endedAt: null }, { endedAt: { gt: from } }] },
        select: { id: true, startedAt: true, endedAt: true },
      });

    if (p.kind === 'MISSING_CHECK_IN') {
      const end = p.proposedEndTime;
      if (!end) throw invalidField('proposedEndTime', 'proposedEndTime is required for a missing check-in');
      if (end <= p.proposedTime) throw invalidField('proposedEndTime', 'The check-out must be after the check-in');
      if (end.getTime() - p.proposedTime.getTime() > MAX_SESSION_HOURS * HOUR) throw invalidField('proposedEndTime', `A session cannot be longer than ${MAX_SESSION_HOURS} hours`);
      const clash = await others(null, p.proposedTime, end);
      if (clash) throw invalidCorrection('These times overlap a recorded work session', { workSessionId: clash.id });
      return null;
    }

    if (!p.workSessionId) throw invalidField('workSessionId', 'workSessionId is required');
    const session = await db.workSession.findFirst({ where: { id: p.workSessionId, employeeId } });
    if (!session) throw AppError.notFound('Work session not found');
    const breaks = await db.breakSession.findMany({ where: { workSessionId: session.id }, select: { startedAt: true, endedAt: true } });
    const firstBreakStart = breaks.length ? Math.min(...breaks.map((b) => b.startedAt.getTime())) : null;
    const lastBreakEnd = breaks.length ? Math.max(...breaks.map((b) => (b.endedAt ?? b.startedAt).getTime())) : null;

    if (p.eventType === 'CHECK_OUT') {
      if (p.kind === 'MISSING_CHECK_OUT' && session.status !== 'MISSING_CHECKOUT') {
        throw invalidCorrection('Only a session marked as a missing check-out can get a check-out this way', { status: session.status });
      }
      if (p.kind === 'WRONG_TIME' && session.status !== 'CLOSED') throw invalidCorrection('Only a closed session has a check-out to correct', { status: session.status });
      if (p.proposedTime <= session.startedAt) throw invalidField('proposedTime', 'The check-out must be after the check-in');
      if (p.proposedTime.getTime() - session.startedAt.getTime() > MAX_SESSION_HOURS * HOUR) throw invalidField('proposedTime', `A session cannot be longer than ${MAX_SESSION_HOURS} hours`);
      if (lastBreakEnd !== null && p.proposedTime.getTime() < lastBreakEnd) throw invalidCorrection('The check-out cannot be before the end of a recorded break');
      const clash = await others(session.id, session.startedAt, p.proposedTime);
      if (clash) throw invalidCorrection('The corrected session would overlap another work session', { workSessionId: clash.id });
      return session;
    }

    // WRONG_TIME on the check-in.
    if (session.status === 'MISSING_CHECKOUT') throw invalidCorrection('Request the missing check-out first', { status: session.status });
    const end = session.endedAt ?? now;
    if (p.proposedTime >= end) throw invalidField('proposedTime', 'The check-in must be before the check-out');
    if (end.getTime() - p.proposedTime.getTime() > MAX_SESSION_HOURS * HOUR) throw invalidField('proposedTime', `A session cannot be longer than ${MAX_SESSION_HOURS} hours`);
    if (firstBreakStart !== null && p.proposedTime.getTime() > firstBreakStart) throw invalidCorrection('The check-in cannot be after the start of a recorded break');
    const clash = await others(session.id, p.proposedTime, end);
    if (clash) throw invalidCorrection('The corrected session would overlap another work session', { workSessionId: clash.id });
    return session;
  }

  private proposal(input: CreateCorrectionInput): Proposal {
    const proposedTime = parseInstant(input.proposedTime, 'proposedTime');
    switch (input.kind) {
      case 'MISSING_CHECK_IN':
        if (!input.proposedEndTime) throw invalidField('proposedEndTime', 'proposedEndTime is required for a missing check-in');
        return { kind: input.kind, eventType: 'CHECK_IN', proposedTime, proposedEndTime: parseInstant(input.proposedEndTime, 'proposedEndTime'), workSessionId: null };
      case 'MISSING_CHECK_OUT':
        return { kind: input.kind, eventType: 'CHECK_OUT', proposedTime, proposedEndTime: null, workSessionId: input.workSessionId ?? null };
      case 'WRONG_TIME':
        if (input.eventType !== 'CHECK_IN' && input.eventType !== 'CHECK_OUT') throw invalidField('eventType', 'eventType must be CHECK_IN or CHECK_OUT');
        return { kind: input.kind, eventType: input.eventType, proposedTime, proposedEndTime: null, workSessionId: input.workSessionId ?? null };
    }
  }

  async create(user: AuthUser, input: CreateCorrectionInput): Promise<CorrectionRequestDto> {
    const employeeId = requireEmployee(user);
    const employee = await this.prisma.employee.findFirst({ where: { id: employeeId, isActive: true, deletedAt: null }, select: EMPLOYEE_REF_SELECT });
    if (!employee) throw AppError.forbidden('NOT_AN_EMPLOYEE', 'No active employee record');
    const p = this.proposal(input);

    const id = await this.prisma.$transaction(async (tx) => {
      const now = await lockEmployee(tx, employeeId);
      await this.validate(tx, employeeId, p, now);
      const duplicate = await tx.attendanceCorrection.findFirst({
        where: p.workSessionId
          ? { employeeId, status: 'PENDING', workSessionId: p.workSessionId, eventType: p.eventType }
          : { employeeId, status: 'PENDING', kind: 'MISSING_CHECK_IN', proposedTime: { lt: p.proposedEndTime! }, proposedEndTime: { gt: p.proposedTime } },
        select: { id: true },
      });
      if (duplicate) throw AppError.conflict('DUPLICATE_REQUEST', 'A correction for this is already waiting for approval', { requestId: duplicate.id });
      const row = await tx.attendanceCorrection.create({
        data: {
          employeeId, requestedById: user.userId, kind: p.kind, eventType: p.eventType, proposedTime: p.proposedTime,
          proposedEndTime: p.proposedEndTime, workSessionId: p.workSessionId, reason: input.reason.trim(),
        },
      });
      await this.audit.record(tx, {
        actorUserId: user.userId, action: 'CORRECTION_REQUEST_CREATE', entityType: 'AttendanceCorrection', entityId: row.id, ipAddress: user.ip,
        after: {
          employeeId, kind: p.kind, eventType: p.eventType, workSessionId: p.workSessionId,
          proposedTime: p.proposedTime.toISOString(), proposedEndTime: p.proposedEndTime?.toISOString() ?? null,
        },
      });
      let recipients = await this.directory.team(P.CORRECTIONS_APPROVE, employee.departmentId, employeeId, tx);
      if (!recipients.length) recipients = await this.directory.companyWide(P.CORRECTIONS_APPROVE, employeeId, tx);
      await this.notifications.notifyMany(recipients, {
        type: REQUEST_NOTIFICATION_TYPES.PENDING_APPROVAL, title: 'Attendance correction waiting for approval',
        body: `${employee.fullName} (${employee.employeeCode}) asked for an attendance correction.`,
        data: {
          type: REQUEST_NOTIFICATION_TYPES.PENDING_APPROVAL, kind: 'CORRECTION', requestId: row.id, correctionKind: p.kind,
          employeeName: employee.fullName, employeeNameAr: employee.fullNameAr, employeeCode: employee.employeeCode,
        },
        dedupeKey: `correction-pending:${row.id}`,
      }, tx);
      return row.id;
    }, TX_OPTIONS);
    return this.get(id);
  }

  async cancel(user: AuthUser, id: string): Promise<CorrectionRequestDto> {
    const existing = await this.prisma.attendanceCorrection.findUnique({ where: { id }, select: { employeeId: true } });
    if (!existing || existing.employeeId !== user.employeeId) throw AppError.notFound('Correction request not found');
    await this.prisma.$transaction(async (tx) => {
      const now = await lockEmployee(tx, existing.employeeId);
      const req = await tx.attendanceCorrection.findUniqueOrThrow({ where: { id } });
      if (req.status !== 'PENDING') throw notPending(req.status);
      await tx.attendanceCorrection.update({ where: { id }, data: { status: 'CANCELLED', decidedAt: now } });
      await this.audit.record(tx, {
        actorUserId: user.userId, action: 'CORRECTION_REQUEST_CANCEL', entityType: 'AttendanceCorrection', entityId: id, ipAddress: user.ip,
        before: { status: 'PENDING' }, after: { status: 'CANCELLED' },
      });
    }, TX_OPTIONS);
    return this.get(id);
  }

  async decide(user: AuthUser, id: string, decision: 'APPROVED' | 'REJECTED', comment: string | undefined): Promise<CorrectionRequestDto> {
    const approver = approverFor(user, P.CORRECTIONS_APPROVE);
    const note = comment?.trim() || null;
    if (decision === 'REJECTED' && !note) throw invalidField('comment', 'A reason is required to reject a request');
    const existing = await this.prisma.attendanceCorrection.findUnique({ where: { id }, include: CORRECTION_INCLUDE });
    if (!existing) throw AppError.notFound('Correction request not found');
    const routed = { employeeId: existing.employeeId, departmentId: existing.employee.departmentId };
    assertMayDecide(approver, routed.employeeId, routed.departmentId, approver !== null && canDecideSingle(approver, routed));

    await this.prisma.$transaction(async (tx) => {
      const now = await lockEmployee(tx, existing.employeeId);
      const req = await tx.attendanceCorrection.findUniqueOrThrow({ where: { id } });
      if (req.status !== 'PENDING') throw notPending(req.status);
      let appliedEventId: string | null = null;
      let workSessionId = req.workSessionId;

      if (decision === 'APPROVED') {
        const p: Proposal = {
          kind: req.kind as CorrectionKind, eventType: req.eventType as Proposal['eventType'], proposedTime: req.proposedTime,
          proposedEndTime: req.proposedEndTime, workSessionId: req.workSessionId,
        };
        const session = await this.validate(tx, req.employeeId, p, now);
        const applied = await this.apply(tx, user, req.id, req.employeeId, p, session);
        appliedEventId = applied.eventId;
        workSessionId = applied.workSessionId;
      }

      await tx.attendanceCorrection.update({
        where: { id },
        data: { status: decision, decidedById: user.userId, decidedAt: now, decisionComment: note, appliedEventId, workSessionId },
      });
      await this.audit.record(tx, {
        actorUserId: user.userId, action: decision === 'APPROVED' ? 'CORRECTION_REQUEST_APPROVE' : 'CORRECTION_REQUEST_REJECT',
        entityType: 'AttendanceCorrection', entityId: id, ipAddress: user.ip,
        before: { status: 'PENDING' }, after: { status: decision, appliedEventId, workSessionId, comment: note },
      });
      const recipient = await tx.user.findFirst({ where: { employeeId: req.employeeId, isActive: true }, select: { id: true } });
      if (recipient) {
        const type = decision === 'APPROVED' ? REQUEST_NOTIFICATION_TYPES.APPROVED : REQUEST_NOTIFICATION_TYPES.REJECTED;
        await this.notifications.notify(recipient.id, {
          type, title: decision === 'APPROVED' ? 'Attendance correction approved' : 'Attendance correction rejected', body: note ?? '',
          data: { type, kind: 'CORRECTION', requestId: id, correctionKind: req.kind, comment: note },
        }, tx);
      }
    }, TX_OPTIONS);
    return this.get(id);
  }

  /** HR corrects any employee's attendance directly (attendance.correct with company-wide access), never their own. */
  private assertMayCorrect(user: AuthUser, employeeId: string): void {
    if (!user.permissions.has(P.ATTENDANCE_CORRECT) || !user.permissions.has(P.ATTENDANCE_READ_ALL)) {
      throw AppError.forbidden('FORBIDDEN', 'Only HR can correct attendance directly');
    }
    if (user.employeeId !== null && user.employeeId === employeeId) {
      throw AppError.forbidden('SELF_APPROVAL_FORBIDDEN', 'You cannot correct your own attendance; submit a correction request instead');
    }
  }

  /**
   * Direct HR correction, applied at once exactly like an approved request (ADMIN_CORRECTION events are
   * appended; nothing is edited or deleted). It is stored as an APPROVED correction whose requester and
   * approver are both the HR user, so it shows in the employee's history and the Approval Center.
   */
  async correctDirect(user: AuthUser, employeeId: string, input: CreateCorrectionInput): Promise<CorrectionRequestDto> {
    this.assertMayCorrect(user, employeeId);
    const employee = await this.prisma.employee.findFirst({ where: { id: employeeId, deletedAt: null }, select: { id: true } });
    if (!employee) throw AppError.notFound('Employee not found');
    const p = this.proposal(input);
    const reason = input.reason.trim();
    if (reason.length < 3) throw invalidField('reason', 'A reason is required');

    const id = await this.prisma.$transaction(async (tx) => {
      const now = await lockEmployee(tx, employeeId);
      const session = await this.validate(tx, employeeId, p, now);
      const correctionId = randomUUID();
      const applied = await this.apply(tx, user, correctionId, employeeId, p, session);
      await tx.attendanceCorrection.create({
        data: {
          id: correctionId, employeeId, requestedById: user.userId, kind: p.kind, eventType: p.eventType, proposedTime: p.proposedTime,
          proposedEndTime: p.proposedEndTime, workSessionId: applied.workSessionId, reason,
          status: 'APPROVED', decidedById: user.userId, decidedAt: now, appliedEventId: applied.eventId,
        },
      });
      await this.audit.record(tx, {
        actorUserId: user.userId, action: 'CORRECTION_DIRECT_APPLY', entityType: 'AttendanceCorrection', entityId: correctionId, ipAddress: user.ip,
        after: {
          employeeId, kind: p.kind, eventType: p.eventType, workSessionId: applied.workSessionId, appliedEventId: applied.eventId,
          proposedTime: p.proposedTime.toISOString(), proposedEndTime: p.proposedEndTime?.toISOString() ?? null, reason, status: 'APPROVED',
        },
      });
      const recipient = await tx.user.findFirst({ where: { employeeId, isActive: true }, select: { id: true } });
      if (recipient) {
        const type = REQUEST_NOTIFICATION_TYPES.APPROVED;
        await this.notifications.notify(recipient.id, {
          type, title: 'Your attendance was corrected by HR', body: reason,
          data: { type, kind: 'CORRECTION', requestId: correctionId, correctionKind: p.kind, comment: reason, direct: true },
        }, tx);
      }
      return correctionId;
    }, TX_OPTIONS);
    return this.get(id);
  }

  /** Appends the ADMIN_CORRECTION event(s) and repairs the session. Existing events are never touched. */
  private async apply(tx: Prisma.TransactionClient, user: AuthUser, correctionId: string, employeeId: string, p: Proposal, session: WorkSession | null) {
    const base = {
      employeeId, source: 'ADMIN_CORRECTION' as const, ipAddress: inetOrZero(user.ip),
      locationVerified: false, actorUserId: user.userId,
    };
    const meta = (extra: Record<string, unknown> = {}) => ({ correctionId, kind: p.kind, ...extra });
    const auditBase = { actorUserId: user.userId, entityType: 'WorkSession', ipAddress: base.ipAddress };

    if (p.kind === 'MISSING_CHECK_IN') {
      const workSessionId = randomUUID();
      const checkIn = await tx.attendanceEvent.create({
        data: { ...base, type: 'CHECK_IN', occurredAt: p.proposedTime, idempotencyKey: randomUUID(), workSessionId, metadata: meta() },
      });
      const checkOut = await tx.attendanceEvent.create({
        data: { ...base, type: 'CHECK_OUT', occurredAt: p.proposedEndTime!, idempotencyKey: randomUUID(), workSessionId, metadata: meta() },
      });
      await tx.workSession.create({
        data: {
          id: workSessionId, employeeId, workDate: dateOnly.toDb(localDate(p.proposedTime)), startedAt: p.proposedTime, endedAt: p.proposedEndTime,
          status: 'CLOSED', startEventId: checkIn.id, endEventId: checkOut.id, locationVerified: false,
        },
      });
      await this.audit.record(tx, {
        ...auditBase, action: 'ATTENDANCE_CORRECTION_APPLIED', entityId: workSessionId,
        before: null, after: { correctionId, kind: p.kind, startedAt: p.proposedTime.toISOString(), endedAt: p.proposedEndTime!.toISOString(), eventIds: [checkIn.id, checkOut.id] },
      });
      return { eventId: checkIn.id, workSessionId };
    }

    const s = session!;
    const before = { status: s.status, startedAt: s.startedAt.toISOString(), endedAt: s.endedAt?.toISOString() ?? null, startEventId: s.startEventId, endEventId: s.endEventId };
    if (p.eventType === 'CHECK_OUT') {
      const ev = await tx.attendanceEvent.create({
        data: { ...base, type: 'CHECK_OUT', occurredAt: p.proposedTime, idempotencyKey: randomUUID(), workSessionId: s.id, metadata: meta({ supersedesEventId: s.endEventId }) },
      });
      await tx.workSession.update({ where: { id: s.id }, data: { status: 'CLOSED', endedAt: p.proposedTime, endEventId: ev.id } });
      await this.audit.record(tx, {
        ...auditBase, action: 'ATTENDANCE_CORRECTION_APPLIED', entityId: s.id,
        before, after: { correctionId, kind: p.kind, status: 'CLOSED', endedAt: p.proposedTime.toISOString(), endEventId: ev.id },
      });
      return { eventId: ev.id, workSessionId: s.id };
    }

    const ev = await tx.attendanceEvent.create({
      data: { ...base, type: 'CHECK_IN', occurredAt: p.proposedTime, idempotencyKey: randomUUID(), workSessionId: s.id, metadata: meta({ supersedesEventId: s.startEventId }) },
    });
    const workDate = localDate(p.proposedTime);
    await tx.workSession.update({ where: { id: s.id }, data: { startedAt: p.proposedTime, startEventId: ev.id, workDate: dateOnly.toDb(workDate) } });
    await this.audit.record(tx, {
      ...auditBase, action: 'ATTENDANCE_CORRECTION_APPLIED', entityId: s.id,
      before: { ...before, workDate: dateOnly.fromDb(s.workDate) }, after: { correctionId, kind: p.kind, startedAt: p.proposedTime.toISOString(), startEventId: ev.id, workDate },
    });
    return { eventId: ev.id, workSessionId: s.id };
  }

  canAct(approver: Approver | null, row: CorrectionRow): boolean {
    return approver !== null && row.status === 'PENDING' && canDecideSingle(approver, { employeeId: row.employeeId, departmentId: row.employee.departmentId });
  }

  // ───────────── Reads ─────────────

  sessions(user: AuthUser): Promise<CorrectableSessionDto[]> {
    return this.sessionsOf(requireEmployee(user));
  }

  /** HR view of an employee's correctable sessions and correction history. */
  private async assertMayReadForCorrection(user: AuthUser, employeeId: string): Promise<void> {
    if (!user.permissions.has(P.ATTENDANCE_CORRECT) || !user.permissions.has(P.ATTENDANCE_READ_ALL)) {
      throw AppError.forbidden('FORBIDDEN', 'Only HR can correct attendance directly');
    }
    const employee = await this.prisma.employee.findFirst({ where: { id: employeeId, deletedAt: null }, select: { id: true } });
    if (!employee) throw AppError.notFound('Employee not found');
  }

  async employeeSessions(user: AuthUser, employeeId: string): Promise<CorrectableSessionDto[]> {
    await this.assertMayReadForCorrection(user, employeeId);
    return this.sessionsOf(employeeId);
  }

  async employeeHistory(user: AuthUser, employeeId: string): Promise<CorrectionRequestDto[]> {
    await this.assertMayReadForCorrection(user, employeeId);
    const rows = await this.prisma.attendanceCorrection.findMany({
      where: { employeeId }, include: CORRECTION_INCLUDE, orderBy: { createdAt: 'desc' }, take: 50,
    });
    return this.toDtos(this.prisma, rows);
  }

  private async sessionsOf(employeeId: string): Promise<CorrectableSessionDto[]> {
    const from = addDays(localDate(new Date()), -CORRECTABLE_DAYS);
    const [sessions, pending] = await Promise.all([
      this.prisma.workSession.findMany({ where: { employeeId, workDate: { gte: dateOnly.toDb(from) } }, orderBy: { startedAt: 'desc' } }),
      this.prisma.attendanceCorrection.findMany({ where: { employeeId, status: 'PENDING', workSessionId: { not: null } }, select: { workSessionId: true } }),
    ]);
    const pendingIds = new Set(pending.map((p) => p.workSessionId));
    return sessions.map((s) => ({
      id: s.id, workDate: dateOnly.fromDb(s.workDate), startedAt: s.startedAt.toISOString(), endedAt: s.endedAt?.toISOString() ?? null,
      status: s.status, pendingCorrection: pendingIds.has(s.id),
    }));
  }

  async get(id: string): Promise<CorrectionRequestDto> {
    const row = await this.prisma.attendanceCorrection.findUnique({ where: { id }, include: CORRECTION_INCLUDE });
    if (!row) throw AppError.notFound('Correction request not found');
    return (await this.toDtos(this.prisma, [row]))[0];
  }

  async mine(user: AuthUser, q: { status?: string }): Promise<CorrectionRequestDto[]> {
    const employeeId = requireEmployee(user);
    const rows = await this.prisma.attendanceCorrection.findMany({
      where: { employeeId, ...(q.status ? { status: q.status as RequestStatus } : {}) },
      include: CORRECTION_INCLUDE, orderBy: { createdAt: 'desc' }, take: 200,
    });
    return this.toDtos(this.prisma, rows);
  }

  async toDtos(db: Db, rows: CorrectionRow[]): Promise<CorrectionRequestDto[]> {
    const sessionIds = [...new Set(rows.map((r) => r.workSessionId).filter((x): x is string => x !== null))];
    const deciderIds = [...new Set(rows.map((r) => r.decidedById).filter((x): x is string => x !== null))];
    const [sessions, deciders] = await Promise.all([
      sessionIds.length ? db.workSession.findMany({ where: { id: { in: sessionIds } } }) : Promise.resolve([]),
      deciderIds.length ? db.user.findMany({ where: { id: { in: deciderIds } }, select: { id: true, username: true } }) : Promise.resolve([]),
    ]);
    const sessionById = new Map(sessions.map((s) => [s.id, s]));
    const deciderById = new Map(deciders.map((u) => [u.id, u]));
    return rows.map((r) => {
      const s = r.workSessionId ? sessionById.get(r.workSessionId) : undefined;
      return {
        id: r.id,
        employee: toEmployeeRef(r.employee),
        kind: r.kind as CorrectionKind,
        eventType: r.eventType as CorrectionRequestDto['eventType'],
        proposedTime: r.proposedTime.toISOString(),
        proposedEndTime: r.proposedEndTime?.toISOString() ?? null,
        workSessionId: r.workSessionId,
        session: s
          ? { workDate: dateOnly.fromDb(s.workDate), startedAt: s.startedAt.toISOString(), endedAt: s.endedAt?.toISOString() ?? null, status: s.status }
          : null,
        reason: r.reason,
        status: r.status,
        decisionComment: r.decisionComment,
        decidedBy: r.decidedById ? deciderById.get(r.decidedById) ?? null : null,
        direct: r.decidedById !== null && r.decidedById === r.requestedById,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        appliedEventId: r.appliedEventId,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  static readonly include = CORRECTION_INCLUDE;
}
