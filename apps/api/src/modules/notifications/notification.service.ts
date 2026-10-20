import { Injectable } from '@nestjs/common';
import type { Notification, Prisma } from '@prisma/client';
import type { NotificationDto, Paginated } from '@workforce/shared';
import { AppError } from '../../common/app-error';
import { PrismaService, type Db } from '../../common/prisma.service';

export interface NotifyInput {
  /** Stable key the UI localises by, e.g. ATTENDANCE_MISSING_CHECKOUT. */
  type: string;
  /** English fallback text. */
  title: string;
  body: string;
  /** Parameters for localised rendering. */
  data?: Record<string, unknown>;
  /** Dedupe is per recipient: the same key never produces a second notification for the same user. */
  dedupeKey?: string;
}

export const notificationToDto = (n: Notification): NotificationDto => ({
  id: n.id, type: n.type, title: n.title, body: n.body, data: (n.data ?? {}) as Record<string, unknown>,
  readAt: n.readAt?.toISOString() ?? null, createdAt: n.createdAt.toISOString(),
});

@Injectable()
export class NotificationService {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns true when a notification was created, false when it was a duplicate. */
  async notify(userId: string, input: NotifyInput, db: Db = this.prisma): Promise<boolean> {
    const { count } = await db.notification.createMany({
      data: [{
        userId, type: input.type, title: input.title, body: input.body,
        data: (input.data ?? { type: input.type }) as Prisma.InputJsonValue,
        dedupeKey: input.dedupeKey ? `${input.dedupeKey}:${userId}` : null,
      }],
      skipDuplicates: true,
    });
    return count > 0;
  }

  async notifyMany(userIds: Iterable<string>, input: NotifyInput, db: Db = this.prisma): Promise<number> {
    let created = 0;
    for (const id of new Set(userIds)) if (await this.notify(id, input, db)) created += 1;
    return created;
  }

  async list(userId: string, q: { unread?: boolean; page?: number; pageSize?: number }): Promise<Paginated<NotificationDto>> {
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));
    const where: Prisma.NotificationWhereInput = { userId, ...(q.unread ? { readAt: null } : {}) };
    const [total, rows] = await Promise.all([
      this.prisma.notification.count({ where }),
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    return { items: rows.map(notificationToDto), total, page, pageSize };
  }

  async unreadCount(userId: string): Promise<{ count: number }> {
    return { count: await this.prisma.notification.count({ where: { userId, readAt: null } }) };
  }

  async markRead(userId: string, id: string): Promise<NotificationDto> {
    const existing = await this.prisma.notification.findFirst({ where: { id, userId } });
    if (!existing) throw AppError.notFound('Notification not found');
    if (existing.readAt) return notificationToDto(existing);
    return notificationToDto(await this.prisma.notification.update({ where: { id }, data: { readAt: new Date() } }));
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const { count } = await this.prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    return { updated: count };
  }
}
