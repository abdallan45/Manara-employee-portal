import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { PERMISSIONS, type DashboardSummary, type LiveAttendanceRow, type Paginated } from '@workforce/shared';
import { CurrentUser, RequirePermissions, type AuthUser } from '../../common/auth';
import { DashboardService, LIVE_SORT_KEYS, type LiveSortKey } from './dashboard.service';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_STATUSES = ['WORKING', 'ON_BREAK', 'CHECKED_OUT', 'ABSENT', 'NOT_SCHEDULED', 'NOT_STARTED', 'ON_LEAVE', 'MISSING_PUNCH', 'PENDING_REVIEW'];

export class SummaryQueryDto {
  @ApiPropertyOptional({ description: 'Local date; default today' }) @IsOptional() @Matches(DATE_RE) date?: string;
}

export class LiveQueryDto {
  @ApiPropertyOptional() @IsOptional() @Matches(DATE_RE) date?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 100) search?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional({ enum: DAY_STATUSES }) @IsOptional() @IsIn(DAY_STATUSES) status?: string;
  @ApiPropertyOptional({ enum: ['FIXED', 'FLEXIBLE'] }) @IsOptional() @IsIn(['FIXED', 'FLEXIBLE']) scheduleType?: string;
  @ApiPropertyOptional({ enum: LIVE_SORT_KEYS }) @IsOptional() @IsIn(LIVE_SORT_KEYS) sort?: LiveSortKey;
  @ApiPropertyOptional({ enum: ['asc', 'desc'] }) @IsOptional() @IsIn(['asc', 'desc']) order?: 'asc' | 'desc';
  @ApiPropertyOptional({ default: 1, maximum: 100000 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page?: number;
  @ApiPropertyOptional({ default: 25 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
}

@ApiTags('Dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @RequirePermissions(PERMISSIONS.DASHBOARD_READ)
  @ApiOperation({ summary: 'KPIs for a date, 14-day trend ending at that date, and per-department comparison' })
  summary(@CurrentUser() user: AuthUser, @Query() q: SummaryQueryDto): Promise<DashboardSummary> {
    return this.dashboard.summary(user, q.date);
  }

  @Get('live')
  @RequirePermissions(PERMISSIONS.DASHBOARD_READ)
  @ApiOperation({ summary: 'Per-employee attendance for a date with filters, sorting and paging' })
  live(@CurrentUser() user: AuthUser, @Query() q: LiveQueryDto): Promise<Paginated<LiveAttendanceRow>> {
    return this.dashboard.live(user, q);
  }
}
