import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { NOTIFICATION_TYPES, PERMISSIONS } from '@workforce/shared';
import { PrismaService } from '../../common/prisma.service';
import { localDate } from '../../common/time';
import { AttendanceService } from '../attendance/attendance.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationService } from './notification.service';

const INTERVAL_NAME = 'attendance-alerts';
const INTERVAL_MS = 5 * 60_000;
const HOUR = 3_600_000;

export interface AlertRunResult { staleSessionsClosed: number; missingCheckoutNotifications: number; breakNotifications: number }

/** Every 5 minutes: close sessions left open too long and warn about overdue breaks. */
@Injectable()
export class AttendanceAlertsJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AttendanceAlertsJob.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly attendance: AttendanceService,
    private readonly notifications: NotificationService,
    private readonly registry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    const handle = setInterval(() => {
      this.run().catch((e) => this.logger.error(`Attendance alert run failed: ${(e as Error).message}`, (e as Error).stack));
    }, INTERVAL_MS);
    this.registry.addInterval(INTERVAL_NAME, handle);
  }

  onModuleDestroy(): void {
    if (this.registry.doesExist('interval', INTERVAL_NAME)) this.registry.deleteInterval(INTERVAL_NAME);
  }

  /** One pass of both checks; exposed for tests and manual triggering. Overlapping runs are skipped. */
  async run(now = new Date()): Promise<AlertRunResult> {
    if (this.running) return { staleSessionsClosed: 0, missingCheckoutNotifications: 0, breakNotifications: 0 };
    this.running = true;
    try {
      const stale = await this.closeStaleSessions(now);
      const breakNotifications = await this.notifyOverdueBreaks(now);
      return { ...stale, breakNotifications };
    } finally {
      this.running = false;
    }
  }

  private async closeStaleSessions(now: Date) {
    const maxHours = Number(await this.settings.get('attendance.maxOpenSessionHours'));
    const cutoff = new Date(now.getTime() - maxHours * HOUR);
    const candidates = await this.prisma.workSession.findMany({ where: { status: 'OPEN', startedAt: { lt: cutoff } }, select: { id: true } });
    let staleSessionsClosed = 0;
    let missingCheckoutNotifications = 0;
    for (const { id } of candidates) {
      const closed = await this.prisma.$transaction(async (tx) => {
        const session = await tx.workSession.findUnique({ where: { id } });
        if (!session) return null;
        await tx.$queryRaw`SELECT id FROM employees WHERE id = ${session.employeeId}::uuid FOR UPDATE`;
        // Re-read under the employee lock: the employee may have checked out meanwhile.
        const current = await tx.workSession.findUnique({ where: { id } });
        if (!current || current.status !== 'OPEN' || current.startedAt >= cutoff) return null;
        const openBreak = await tx.breakSession.findFirst({ where: { workSessionId: id, endedAt: null } });
        await this.attendance.markMissingCheckout(tx, current, openBreak, { actorUserId: null, ip: null, trigger: 'JOB' });
        return current;
      });
      if (!closed) continue;
      staleSessionsClosed += 1;

      const employee = await this.prisma.employee.findUnique({
        where: { id: closed.employeeId },
        select: { id: true, fullName: true, fullNameAr: true, employeeCode: true, departmentId: true, user: { select: { id: true } } },
      });
      if (!employee) continue;
      const recipients = await this.supervisors(employee.departmentId);
      const data = {
        type: NOTIFICATION_TYPES.MISSING_CHECKOUT, sessionId: closed.id, employeeId: employee.id, employeeName: employee.fullName,
        employeeNameAr: employee.fullNameAr, employeeCode: employee.employeeCode, startedAt: closed.startedAt.toISOString(),
        workDate: localDate(closed.startedAt), maxOpenSessionHours: maxHours,
      };
      const dedupeKey = `missing-checkout:${closed.id}`;
      if (employee.user) {
        if (await this.notifications.notify(employee.user.id, {
          type: NOTIFICATION_TYPES.MISSING_CHECKOUT, title: 'Missing check-out',
          body: `You did not check out of the session started on ${data.workDate}. Please request a correction.`, data, dedupeKey,
        })) missingCheckoutNotifications += 1;
      }
      missingCheckoutNotifications += await this.notifications.notifyMany(
        recipients.filter((u) => u !== employee.user?.id),
        {
          type: NOTIFICATION_TYPES.MISSING_CHECKOUT, title: 'Missing check-out',
          body: `${employee.fullName} (${employee.employeeCode}) did not check out of the session started on ${data.workDate}.`, data, dedupeKey,
        },
      );
    }
    return { staleSessionsClosed, missingCheckoutNotifications };
  }

  /** Active users with company-wide attendance read access, plus managers of the department. */
  private async supervisors(departmentId: string | null): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: {
        isActive: true, deletedAt: null,
        roles: {
          some: {
            OR: [
              { role: { permissions: { some: { permission: { key: PERMISSIONS.ATTENDANCE_READ_ALL } } } } },
              ...(departmentId
                ? [{ departmentId, role: { permissions: { some: { permission: { key: PERMISSIONS.ATTENDANCE_READ_TEAM } } } } }]
                : []),
            ],
          },
        },
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  private async notifyOverdueBreaks(now: Date): Promise<number> {
    const open = await this.prisma.breakSession.findMany({
      where: { endedAt: null, breakType: { notifyAfterMinutes: { not: null } }, workSession: { status: 'OPEN' } },
      include: { breakType: true, employee: { select: { user: { select: { id: true } } } } },
    });
    let created = 0;
    for (const b of open) {
      const limit = b.breakType.notifyAfterMinutes!;
      const minutes = Math.floor((now.getTime() - b.startedAt.getTime()) / 60_000);
      const userId = b.employee.user?.id;
      if (minutes < limit || !userId) continue;
      const ok = await this.notifications.notify(userId, {
        type: NOTIFICATION_TYPES.BREAK_OVERDUE,
        title: 'Break running long',
        body: `Your ${b.breakType.name} break has lasted ${minutes} minutes (limit ${limit}).`,
        data: {
          type: NOTIFICATION_TYPES.BREAK_OVERDUE, breakSessionId: b.id, breakTypeId: b.breakTypeId, breakTypeCode: b.breakType.code,
          breakTypeName: b.breakType.name, breakTypeNameAr: b.breakType.nameAr, startedAt: b.startedAt.toISOString(),
          minutes, notifyAfterMinutes: limit,
        },
        dedupeKey: `long-break:${b.id}`,
      });
      if (ok) created += 1;
    }
    return created;
  }
}
