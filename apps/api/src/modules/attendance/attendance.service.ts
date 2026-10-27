import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type BreakSession, type WorkSession } from '@prisma/client';
import type {
  AttendanceAction, AttendanceEventDto, AttendanceState, AttendanceStatusDto, DayMetrics, DeviceLocation, EventSource, Paginated,
} from '@workforce/shared';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../common/auth';
import { PrismaService, type Db } from '../../common/prisma.service';
import { attendanceScope, inScope } from '../../common/scope';
import { addDays, dateOnly, localDate, startOfLocalDay, TIMEZONE, weekdayOf } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { inetOrZero } from '../../common/ip';
import { GeofenceService, type LocationVerdict } from '../offices/geofence.service';
import { SettingsService } from '../settings/settings.service';
import { AttendanceMetricsService } from './attendance-metrics.service';
import { breakTypeToDto } from './break-types.service';
import { sumPeriod } from './calc';
import { resolveRange } from './date-range';

export interface ActionInput {
  action: AttendanceAction;
  idempotencyKey: string;
  breakTypeId?: string;
  /** Device location; required for check-in and check-out, recorded when sent with a break action. */
  location?: DeviceLocation;
}

/** Actions whose device location must be inside an office (unless remote work or FLAG). */
const LOCATION_CHECKED: ReadonlySet<AttendanceAction> = new Set(['CHECK_IN', 'CHECK_OUT']);

const LOCATION_MESSAGES: Record<NonNullable<LocationVerdict['problem']>, string> = {
  LOCATION_REQUIRED: 'Allow location access to check in or out',
  LOCATION_INACCURATE: 'The device location is too imprecise; turn on GPS or move near a window and try again',
  LOCATION_OUTSIDE_OFFICE: 'You are not at the office',
  LOCATION_NOT_CONFIGURED: 'No office location is set up yet; ask an administrator',
};

/** Thrown inside the transaction so it rolls back; the denial is audited afterwards. */
class LocationDenied extends Error {}

const HOUR = 3_600_000;

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly geofence: GeofenceService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly metrics: AttendanceMetricsService,
  ) {}

  private requireEmployee(user: AuthUser): string {
    if (!user.employeeId) throw AppError.forbidden('NOT_AN_EMPLOYEE', 'Your account is not linked to an employee record');
    return user.employeeId;
  }

  private invalid(state: AttendanceState, action: AttendanceAction, extra: Record<string, unknown> = {}): AppError {
    return AppError.conflict('ATTENDANCE_INVALID_TRANSITION', `Cannot ${action} while ${state}`, { state, action, ...extra });
  }

  private async sourceOf(user: AuthUser): Promise<EventSource> {
    try {
      const session = await this.prisma.session.findUnique({ where: { id: user.sessionId }, select: { client: true } });
      return session?.client === 'MOBILE' ? 'MOBILE' : 'WEB';
    } catch {
      return 'WEB';
    }
  }

  /**
   * Marks a session that was left open past the limit as MISSING_CHECKOUT. An open break is closed
   * at its own start time (zero length) so no work or break time is invented.
   */
  async markMissingCheckout(
    tx: Prisma.TransactionClient,
    session: WorkSession,
    openBreak: BreakSession | null,
    ctx: { actorUserId: string | null; ip: string | null; trigger: 'CHECK_IN' | 'JOB' },
  ): Promise<void> {
    await tx.workSession.update({ where: { id: session.id }, data: { status: 'MISSING_CHECKOUT' } });
    if (openBreak) {
      await tx.breakSession.update({ where: { id: openBreak.id }, data: { endedAt: openBreak.startedAt, autoClosed: true } });
    }
    await this.audit.record(tx, {
      actorUserId: ctx.actorUserId, action: 'ATTENDANCE_MISSING_CHECKOUT', entityType: 'WorkSession', entityId: session.id,
      before: { status: 'OPEN', startedAt: session.startedAt.toISOString() },
      after: { status: 'MISSING_CHECKOUT', trigger: ctx.trigger, autoClosedBreakId: openBreak?.id ?? null },
      ipAddress: ctx.ip,
    });
  }

  /** True when an approved remote-work request covers local date `date` for this employee. */
  async remoteOn(employeeId: string, date: string, db: Db = this.prisma): Promise<boolean> {
    const n = await db.leaveRequest.count({
      where: {
        employeeId, status: 'APPROVED', leaveType: { isRemoteWork: true },
        startAt: { lt: startOfLocalDay(addDays(date, 1)) }, endAt: { gt: startOfLocalDay(date) },
      },
    });
    return n > 0;
  }

  async perform(user: AuthUser, input: ActionInput): Promise<AttendanceStatusDto> {
    const employeeId = this.requireEmployee(user);
    const [enforcement, maxAccuracy, maxHours, source] = await Promise.all([
      this.settings.get('attendance.locationEnforcement'),
      this.settings.get('attendance.maxLocationAccuracyMeters'),
      this.settings.get('attendance.maxOpenSessionHours'),
      this.sourceOf(user),
    ]);
    const where = await this.geofence.verify(input.location, Number(maxAccuracy));
    try {
      await this.prisma.$transaction(
        (tx) => this.apply(tx, user, employeeId, input, { where, enforcement, maxHours: Number(maxHours), source }),
        { maxWait: 15_000, timeout: 20_000 },
      );
    } catch (e) {
      if (e instanceof LocationDenied) {
        const problem = where.problem!;
        const details = {
          distanceMeters: where.distance, radiusMeters: where.office?.radiusMeters ?? null, officeName: where.office?.name ?? null,
          accuracyMeters: where.location?.accuracy ?? null, maxAccuracyMeters: Number(maxAccuracy),
        };
        await this.audit.record(this.prisma, {
          actorUserId: user.userId, action: 'ATTENDANCE_DENIED_LOCATION', entityType: 'Employee', entityId: employeeId,
          after: { action: input.action, problem, location: where.location, ...details, idempotencyKey: input.idempotencyKey },
          ipAddress: inetOrZero(user.ip),
        });
        throw AppError.forbidden(problem, LOCATION_MESSAGES[problem], details);
      }
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        // A concurrent action won the race on one of the partial unique indexes.
        throw AppError.conflict('ATTENDANCE_INVALID_TRANSITION', 'Another attendance action was recorded at the same time', { action: input.action, race: true });
      }
      throw e;
    }
    return this.status(user);
  }

  private async apply(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    employeeId: string,
    input: ActionInput,
    opts: { where: LocationVerdict; enforcement: 'ENFORCE' | 'FLAG'; maxHours: number; source: EventSource },
  ): Promise<void> {
    // Serialises all attendance actions of this employee.
    const locked = await tx.$queryRaw<{ id: string; now: Date }[]>`
      SELECT id, clock_timestamp() AS now FROM employees
      WHERE id = ${employeeId}::uuid AND is_active AND deleted_at IS NULL FOR UPDATE`;
    if (!locked.length) throw AppError.forbidden('NOT_AN_EMPLOYEE', 'No active employee record');
    const now = new Date(locked[0].now);

    const { action, idempotencyKey } = input;
    const existing = await tx.attendanceEvent.findUnique({ where: { employeeId_idempotencyKey: { employeeId, idempotencyKey } } });
    if (existing) {
      if (existing.type === action) return;
      throw AppError.conflict('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different action', { existingType: existing.type, action });
    }

    const { where } = opts;
    const checked = LOCATION_CHECKED.has(action);
    // Approved remote work for today waives the location rule; the events stay unverified and are marked remote.
    const remote = checked && !where.verified && await this.remoteOn(employeeId, localDate(now), tx);
    if (checked && !where.verified && opts.enforcement === 'ENFORCE' && !remote) throw new LocationDenied();
    const remoteMeta = remote ? { remote: true } : {};
    // FLAG mode: why an accepted check-in / check-out is unverified, for whoever reviews it.
    const flagMeta = checked && !where.verified && !remote ? { locationProblem: where.problem } : {};

    const session = await tx.workSession.findFirst({ where: { employeeId, status: 'OPEN' } });
    const openBreak = session ? await tx.breakSession.findFirst({ where: { employeeId, workSessionId: session.id, endedAt: null } }) : null;
    const state: AttendanceState = !session ? 'OFF' : openBreak ? 'ON_BREAK' : 'WORKING';
    const stale = session !== null && now.getTime() - session.startedAt.getTime() > opts.maxHours * HOUR;

    const meta = { ...remoteMeta, ...flagMeta };
    const base = {
      employeeId, source: opts.source,
      ipAddress: inetOrZero(user.ip),
      locationVerified: where.verified,
      latitude: where.location?.latitude ?? null, longitude: where.location?.longitude ?? null,
      accuracyMeters: where.location?.accuracy ?? null, distanceMeters: where.location ? where.distance : null,
      officeId: where.location ? where.office?.id ?? null : null,
      actorUserId: user.userId,
      ...(Object.keys(meta).length ? { metadata: meta } : {}),
    };
    const auditBase = { actorUserId: user.userId, entityType: 'AttendanceEvent', ipAddress: base.ipAddress };

    if (session && stale && action !== 'CHECK_IN') {
      throw this.invalid(state, action, {
        reason: 'STALE_SESSION', sessionId: session.id, startedAt: session.startedAt.toISOString(), maxOpenSessionHours: opts.maxHours,
      });
    }

    switch (action) {
      case 'CHECK_IN': {
        if (session && !stale) throw this.invalid(state, action);
        if (session) await this.markMissingCheckout(tx, session, openBreak, { actorUserId: user.userId, ip: base.ipAddress, trigger: 'CHECK_IN' });
        const workSessionId = randomUUID();
        const ev = await tx.attendanceEvent.create({ data: { ...base, type: 'CHECK_IN', idempotencyKey, workSessionId } });
        await tx.workSession.create({
          data: {
            id: workSessionId, employeeId, workDate: dateOnly.toDb(localDate(ev.occurredAt)),
            startedAt: ev.occurredAt, startEventId: ev.id, locationVerified: where.verified,
          },
        });
        await this.audit.record(tx, { ...auditBase, action: 'ATTENDANCE_CHECK_IN', entityId: ev.id, after: { workSessionId, occurredAt: ev.occurredAt.toISOString(), locationVerified: where.verified, location: where.location, distanceMeters: where.distance, staleSessionId: session?.id ?? null, ...meta } });
        return;
      }
      case 'BREAK_START': {
        if (!session || openBreak) throw this.invalid(state, action);
        const breakType = await tx.breakType.findUnique({ where: { id: input.breakTypeId ?? '' } });
        if (!breakType) throw AppError.notFound('Break type not found');
        if (!breakType.isActive) throw new AppError('BREAK_TYPE_INACTIVE', 'This break type is not active', HttpStatus.CONFLICT, { breakTypeId: breakType.id });
        const breakSessionId = randomUUID();
        const ev = await tx.attendanceEvent.create({
          data: { ...base, type: 'BREAK_START', idempotencyKey, workSessionId: session.id, breakSessionId, breakTypeId: breakType.id },
        });
        await tx.breakSession.create({
          data: { id: breakSessionId, workSessionId: session.id, employeeId, breakTypeId: breakType.id, startedAt: ev.occurredAt, startEventId: ev.id },
        });
        await this.audit.record(tx, { ...auditBase, action: 'ATTENDANCE_BREAK_START', entityId: ev.id, after: { breakSessionId, breakTypeId: breakType.id, occurredAt: ev.occurredAt.toISOString() } });
        return;
      }
      case 'BREAK_END': {
        if (!session || !openBreak) throw this.invalid(state, action);
        const ev = await tx.attendanceEvent.create({
          data: { ...base, type: 'BREAK_END', idempotencyKey, workSessionId: session.id, breakSessionId: openBreak.id, breakTypeId: openBreak.breakTypeId },
        });
        await tx.breakSession.update({ where: { id: openBreak.id }, data: { endedAt: ev.occurredAt, endEventId: ev.id } });
        await this.audit.record(tx, { ...auditBase, action: 'ATTENDANCE_BREAK_END', entityId: ev.id, after: { breakSessionId: openBreak.id, occurredAt: ev.occurredAt.toISOString() } });
        return;
      }
      case 'CHECK_OUT': {
        if (!session) throw this.invalid(state, action);
        let at: Date | undefined;
        if (openBreak) {
          const auto = await tx.attendanceEvent.create({
            data: {
              ...base, type: 'BREAK_END', idempotencyKey: randomUUID(), workSessionId: session.id, breakSessionId: openBreak.id,
              breakTypeId: openBreak.breakTypeId, metadata: { auto: true, reason: 'CHECK_OUT', checkOutIdempotencyKey: idempotencyKey, ...remoteMeta },
            },
          });
          at = auto.occurredAt;
          await tx.breakSession.update({ where: { id: openBreak.id }, data: { endedAt: at, endEventId: auto.id } });
          await this.audit.record(tx, { ...auditBase, action: 'ATTENDANCE_BREAK_END', entityId: auto.id, after: { breakSessionId: openBreak.id, auto: true, occurredAt: at.toISOString() } });
        }
        // Same instant as the auto break end, otherwise the DB clock.
        const ev = await tx.attendanceEvent.create({
          data: { ...base, type: 'CHECK_OUT', idempotencyKey, workSessionId: session.id, ...(at ? { occurredAt: at } : {}) },
        });
        // A session counts as verified only when both its check-in and check-out were.
        await tx.workSession.update({
          where: { id: session.id },
          data: { status: 'CLOSED', endedAt: ev.occurredAt, endEventId: ev.id, ...(where.verified ? {} : { locationVerified: false }) },
        });
        await this.audit.record(tx, {
          ...auditBase, action: 'ATTENDANCE_CHECK_OUT', entityId: ev.id,
          after: {
            workSessionId: session.id, occurredAt: ev.occurredAt.toISOString(), autoEndedBreakId: openBreak?.id ?? null,
            locationVerified: where.verified, location: where.location, distanceMeters: where.distance, ...meta,
          },
        });
        return;
      }
    }
  }

  async status(user: AuthUser): Promise<AttendanceStatusDto> {
    const employeeId = this.requireEmployee(user);
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, isActive: true, deletedAt: null },
      select: { id: true, departmentId: true, locationId: true },
    });
    if (!employee) throw AppError.forbidden('NOT_AN_EMPLOYEE', 'No active employee record');

    const now = new Date();
    const today = localDate(now);
    const weekStart = addDays(today, -weekdayOf(today));
    const monthStart = `${today.slice(0, 8)}01`;
    const from = weekStart < monthStart ? weekStart : monthStart;

    const [offices, enforcement, maxAccuracy, remote, openSession, openBreak, breakTypes, range, leaves] = await Promise.all([
      this.geofence.offices(),
      this.settings.get('attendance.locationEnforcement'),
      this.settings.get('attendance.maxLocationAccuracyMeters'),
      this.remoteOn(employeeId, today),
      this.prisma.workSession.findFirst({ where: { employeeId, status: 'OPEN' } }),
      this.prisma.breakSession.findFirst({ where: { employeeId, endedAt: null }, include: { breakType: true } }),
      this.prisma.breakType.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.metrics.computeRange([employee], from, today, now),
      // Approved leave touching today; remote work is a working day, not leave.
      this.prisma.leaveRequest.findMany({
        where: {
          employeeId, status: 'APPROVED', leaveType: { isRemoteWork: false },
          startAt: { lt: startOfLocalDay(addDays(today, 1)) }, endAt: { gt: startOfLocalDay(today) },
        },
        select: { mode: true, startAt: true, endAt: true, leaveType: { select: { name: true, nameAr: true } } },
        orderBy: { startAt: 'asc' },
      }),
    ]);
    const days = range.days.get(employee.id)!;
    const activeBreak = openSession && openBreak && openBreak.workSessionId === openSession.id ? openBreak : null;
    const holiday = range.context.holiday(employee, today);
    // The employee's own request, so a sensitive type is named too.
    const leave = leaves.find((l) => l.mode === 'FULL_DAY')
      ?? leaves.find((l) => l.startAt <= now && now < l.endAt)
      ?? leaves.find((l) => l.startAt > now)
      ?? leaves[0]
      ?? null;

    return {
      state: !openSession ? 'OFF' : activeBreak ? 'ON_BREAK' : 'WORKING',
      serverTime: now.toISOString(),
      timezone: TIMEZONE,
      location: { enforcement, maxAccuracyMeters: Number(maxAccuracy), remote, offices },
      openSession: openSession ? { id: openSession.id, startedAt: openSession.startedAt.toISOString() } : null,
      openBreak: activeBreak ? { id: activeBreak.id, startedAt: activeBreak.startedAt.toISOString(), breakType: breakTypeToDto(activeBreak.breakType) } : null,
      today: days[days.length - 1],
      todayHoliday: holiday ? { name: holiday.name, nameAr: holiday.nameAr } : null,
      todayLeave: leave
        ? {
            leaveTypeName: leave.leaveType.name, leaveTypeNameAr: leave.leaveType.nameAr, mode: leave.mode,
            startAt: leave.startAt.toISOString(), endAt: leave.endAt.toISOString(),
          }
        : null,
      week: sumPeriod(days.filter((d) => d.workDate >= weekStart)),
      month: sumPeriod(days.filter((d) => d.workDate >= monthStart)),
      breakTypes: breakTypes.map(breakTypeToDto),
    };
  }

  /** Throws unless the user may read this employee's attendance (scope by department). */
  async assertCanView(user: AuthUser, employeeId: string) {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, deletedAt: null },
      select: { id: true, departmentId: true, locationId: true },
    });
    if (!employee) throw AppError.notFound('Employee not found');
    // Out of scope answers like a missing employee, so ids outside the scope cannot be probed.
    if (employee.id !== user.employeeId && !inScope(attendanceScope(user), employee)) {
      throw AppError.notFound('Employee not found');
    }
    return employee;
  }

  async days(employeeId: string, from?: string, to?: string): Promise<DayMetrics[]> {
    const employee = await this.prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, departmentId: true, locationId: true } });
    if (!employee) throw AppError.notFound('Employee not found');
    const range = resolveRange(from, to, 62);
    return (await this.metrics.computeRange([employee], range.from, range.to)).days.get(employee.id)!;
  }

  async events(employeeId: string, q: { from?: string; to?: string; page?: number; pageSize?: number }): Promise<Paginated<AttendanceEventDto>> {
    const range = resolveRange(q.from, q.to, 366);
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
    const where: Prisma.AttendanceEventWhereInput = {
      employeeId,
      occurredAt: { gte: startOfLocalDay(range.from), lt: startOfLocalDay(addDays(range.to, 1)) },
    };
    const [total, rows] = await Promise.all([
      this.prisma.attendanceEvent.count({ where }),
      this.prisma.attendanceEvent.findMany({
        where, orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }], skip: (page - 1) * pageSize, take: pageSize,
        include: { office: { select: { name: true } } },
      }),
    ]);
    const typeIds = [...new Set(rows.map((r) => r.breakTypeId).filter((x): x is string => x !== null))];
    const types = typeIds.length ? await this.prisma.breakType.findMany({ where: { id: { in: typeIds } }, select: { id: true, name: true, nameAr: true } }) : [];
    const typeById = new Map(types.map((t) => [t.id, t]));
    return {
      items: rows.map((r) => ({
        id: r.id, type: r.type, occurredAt: r.occurredAt.toISOString(), source: r.source,
        locationVerified: r.locationVerified, ipAddress: r.ipAddress,
        latitude: r.latitude, longitude: r.longitude, accuracyMeters: r.accuracyMeters, distanceMeters: r.distanceMeters,
        officeName: r.office?.name ?? null,
        breakTypeName: r.breakTypeId ? typeById.get(r.breakTypeId)?.name ?? null : null,
        breakTypeNameAr: r.breakTypeId ? typeById.get(r.breakTypeId)?.nameAr ?? null : null,
      })),
      total, page, pageSize,
    };
  }
}
