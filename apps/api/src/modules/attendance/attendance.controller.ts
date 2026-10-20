import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS, type AttendanceEventDto, type AttendanceStatusDto, type BreakTypeDto, type DayMetrics, type Paginated,
} from '@workforce/shared';
import { AppError } from '../../common/app-error';
import { CurrentUser, RequireAnyPermission, RequirePermissions, type AuthUser } from '../../common/auth';
import {
  AttendanceActionDto, BreakStartDto, BreakTypesQueryDto, CreateBreakTypeDto, DateRangeQueryDto, EventsQueryDto, UpdateBreakTypeDto,
} from './attendance.dto';
import { AttendanceService } from './attendance.service';
import { BreakTypesService } from './break-types.service';

const P = PERMISSIONS;

const selfEmployee = (user: AuthUser): string => {
  if (!user.employeeId) throw AppError.forbidden('NOT_AN_EMPLOYEE', 'Your account is not linked to an employee record');
  return user.employeeId;
};

@ApiTags('Attendance')
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get('me/status')
  @RequirePermissions(P.ATTENDANCE_SELF)
  @ApiOperation({ summary: 'Current state, today / week / month figures, break types and office locations' })
  status(@CurrentUser() user: AuthUser): Promise<AttendanceStatusDto> {
    return this.attendance.status(user);
  }

  @Post('me/check-in')
  @HttpCode(200)
  @RequirePermissions(P.ATTENDANCE_SELF)
  @ApiOperation({ summary: 'Check in (server time is authoritative)' })
  checkIn(@CurrentUser() user: AuthUser, @Body() body: AttendanceActionDto): Promise<AttendanceStatusDto> {
    return this.attendance.perform(user, { action: 'CHECK_IN', idempotencyKey: body.idempotencyKey, location: body.location });
  }

  @Post('me/check-out')
  @HttpCode(200)
  @RequirePermissions(P.ATTENDANCE_SELF)
  @ApiOperation({ summary: 'Check out (ends an open break first)' })
  checkOut(@CurrentUser() user: AuthUser, @Body() body: AttendanceActionDto): Promise<AttendanceStatusDto> {
    return this.attendance.perform(user, { action: 'CHECK_OUT', idempotencyKey: body.idempotencyKey, location: body.location });
  }

  @Post('me/break/start')
  @HttpCode(200)
  @RequirePermissions(P.ATTENDANCE_SELF)
  @ApiOperation({ summary: 'Start a break of the given type' })
  breakStart(@CurrentUser() user: AuthUser, @Body() body: BreakStartDto): Promise<AttendanceStatusDto> {
    return this.attendance.perform(user, { action: 'BREAK_START', idempotencyKey: body.idempotencyKey, breakTypeId: body.breakTypeId, location: body.location });
  }

  @Post('me/break/end')
  @HttpCode(200)
  @RequirePermissions(P.ATTENDANCE_SELF)
  @ApiOperation({ summary: 'End the current break' })
  breakEnd(@CurrentUser() user: AuthUser, @Body() body: AttendanceActionDto): Promise<AttendanceStatusDto> {
    return this.attendance.perform(user, { action: 'BREAK_END', idempotencyKey: body.idempotencyKey, location: body.location });
  }

  @Get('me/events')
  @RequirePermissions(P.ATTENDANCE_SELF)
  @ApiOperation({ summary: 'My attendance events (newest first)' })
  myEvents(@CurrentUser() user: AuthUser, @Query() q: EventsQueryDto): Promise<Paginated<AttendanceEventDto>> {
    return this.attendance.events(selfEmployee(user), q);
  }

  @Get('me/days')
  @RequirePermissions(P.ATTENDANCE_SELF)
  @ApiOperation({ summary: 'My daily metrics for a date range (max 62 days)' })
  myDays(@CurrentUser() user: AuthUser, @Query() q: DateRangeQueryDto): Promise<DayMetrics[]> {
    return this.attendance.days(selfEmployee(user), q.from, q.to);
  }

  @Get('employees/:id/days')
  @RequireAnyPermission(P.ATTENDANCE_READ_TEAM, P.ATTENDANCE_READ_ALL)
  @ApiOperation({ summary: 'Daily metrics of an employee in my scope (max 62 days)' })
  async employeeDays(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: DateRangeQueryDto): Promise<DayMetrics[]> {
    await this.attendance.assertCanView(user, id);
    return this.attendance.days(id, q.from, q.to);
  }

  @Get('employees/:id/events')
  @RequireAnyPermission(P.ATTENDANCE_READ_TEAM, P.ATTENDANCE_READ_ALL)
  @ApiOperation({ summary: 'Attendance events of an employee in my scope' })
  async employeeEvents(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: EventsQueryDto): Promise<Paginated<AttendanceEventDto>> {
    await this.attendance.assertCanView(user, id);
    return this.attendance.events(id, q);
  }
}

@ApiTags('Break types')
@Controller('break-types')
export class BreakTypesController {
  constructor(private readonly breakTypes: BreakTypesService) {}

  @Get()
  @ApiOperation({ summary: 'List break types (active only unless includeInactive=true and the caller manages break types)' })
  list(@CurrentUser() user: AuthUser, @Query() q: BreakTypesQueryDto): Promise<BreakTypeDto[]> {
    return this.breakTypes.list(q.includeInactive === 'true' && user.permissions.has(P.BREAK_TYPES_MANAGE));
  }

  @Post()
  @RequirePermissions(P.BREAK_TYPES_MANAGE)
  @ApiOperation({ summary: 'Create a break type' })
  create(@CurrentUser() user: AuthUser, @Body() body: CreateBreakTypeDto): Promise<BreakTypeDto> {
    return this.breakTypes.create(user, body);
  }

  @Patch(':id')
  @RequirePermissions(P.BREAK_TYPES_MANAGE)
  @ApiOperation({ summary: 'Update a break type' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateBreakTypeDto): Promise<BreakTypeDto> {
    return this.breakTypes.update(user, id, body);
  }
}
