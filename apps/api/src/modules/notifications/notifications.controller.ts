import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import type { NotificationDto, Paginated } from '@workforce/shared';
import { CurrentUser, type AuthUser } from '../../common/auth';
import { NotificationService } from './notification.service';

export class NotificationsQueryDto {
  @ApiPropertyOptional({ enum: ['true', 'false'] }) @IsOptional() @IsIn(['true', 'false', true, false]) unread?: string | boolean;
  @ApiPropertyOptional({ default: 1, maximum: 100000 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page?: number;
  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  @ApiOperation({ summary: 'My notifications (newest first)' })
  list(@CurrentUser() user: AuthUser, @Query() q: NotificationsQueryDto): Promise<Paginated<NotificationDto>> {
    return this.notifications.list(user.userId, { unread: q.unread === true || q.unread === 'true', page: q.page, pageSize: q.pageSize });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Number of my unread notifications' })
  unreadCount(@CurrentUser() user: AuthUser): Promise<{ count: number }> {
    return this.notifications.unreadCount(user.userId);
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark all my notifications as read' })
  readAll(@CurrentUser() user: AuthUser): Promise<{ updated: number }> {
    return this.notifications.markAllRead(user.userId);
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark one of my notifications as read' })
  read(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<NotificationDto> {
    return this.notifications.markRead(user.userId, id);
  }
}
