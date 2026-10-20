import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID, Matches } from 'class-validator';
import { PERMISSIONS, type AttendanceReportDto } from '@workforce/shared';
import { AppError } from '../../common/app-error';
import { CurrentUser, RequireAnyPermission, type AuthUser } from '../../common/auth';
import { MAX_REPORT_DAYS, ReportsService } from './reports.service';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class AttendanceReportQueryDto {
  @ApiPropertyOptional({ example: '2026-10-01', description: 'Local date; default first day of the month of `to`' }) @IsOptional() @Matches(DATE_RE) from?: string;
  @ApiPropertyOptional({ example: '2026-10-31', description: 'Local date; default today' }) @IsOptional() @Matches(DATE_RE) to?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'One employee; the row then includes daily figures' }) @IsOptional() @IsUUID() employeeId?: string;
  @ApiPropertyOptional({ description: 'true: daily figures for every employee plus the leave, overtime and correction records of the period' })
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() detail?: boolean;
  @ApiPropertyOptional({ description: 'true: the report is fetched for a download (Excel / CSV); requires reports.export' })
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() export?: boolean;
}

@ApiTags('Reports')
@Controller('reports')
@RequireAnyPermission(PERMISSIONS.REPORTS_READ_ALL, PERMISSIONS.REPORTS_READ_TEAM)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('attendance')
  @ApiOperation({
    summary: `Attendance, absence, lateness, leave and overtime totals per employee (max ${MAX_REPORT_DAYS} days; team scope for managers). `
      + 'detail=true (the full export data) and export=true (any download) also require reports.export',
  })
  attendance(@CurrentUser() user: AuthUser, @Query() q: AttendanceReportQueryDto): Promise<AttendanceReportDto> {
    // detail=true is only ever fetched to build a download, so it is an export like export=true.
    if ((q.detail || q.export) && !user.permissions.has(PERMISSIONS.REPORTS_EXPORT)) {
      throw AppError.forbidden('FORBIDDEN', 'Exporting reports requires the reports.export permission');
    }
    return this.reports.attendance(user, { from: q.from, to: q.to, departmentId: q.departmentId, employeeId: q.employeeId, detail: q.detail });
  }
}
