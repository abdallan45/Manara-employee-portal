import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type EmployeeScheduleDto, type HolidayDto, type ScheduleAssignmentDto, type ScheduleDto } from '@workforce/shared';
import { CurrentUser, RequireAnyPermission, RequirePermissions, type AuthUser } from '../../common/auth';
import {
  CreateAssignmentDto, CreateHolidayDto, CreateHolidayRangeDto, CreateScheduleDto, CurrentScheduleQueryDto, HolidayQueryDto, UpdateAssignmentDto,
  UpdateHolidayDto, UpdateScheduleDto,
} from './schedules.dto';
import { SchedulesService } from './schedules.service';

const P = PERMISSIONS;

@ApiTags('Schedules')
@Controller()
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get('schedules')
  @RequireAnyPermission(P.SCHEDULES_MANAGE, P.ATTENDANCE_READ_TEAM, P.ATTENDANCE_READ_ALL)
  @ApiOperation({ summary: 'List work schedules with their weekdays' })
  list(): Promise<ScheduleDto[]> {
    return this.schedules.list();
  }

  @Post('schedules')
  @RequirePermissions(P.SCHEDULES_MANAGE)
  @ApiOperation({ summary: 'Create a work schedule' })
  create(@CurrentUser() user: AuthUser, @Body() body: CreateScheduleDto): Promise<ScheduleDto> {
    return this.schedules.create(user, body);
  }

  @Patch('schedules/:id')
  @RequirePermissions(P.SCHEDULES_MANAGE)
  @ApiOperation({ summary: 'Update a work schedule (days, when given, replace all weekdays)' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateScheduleDto): Promise<ScheduleDto> {
    return this.schedules.update(user, id, body);
  }

  @Get('schedules/assignments')
  @RequirePermissions(P.SCHEDULES_MANAGE)
  @ApiOperation({ summary: 'All assignments (employees and departments) with display names' })
  allAssignments(): Promise<ScheduleAssignmentDto[]> {
    return this.schedules.listAllAssignments();
  }

  @Patch('schedules/assignments/:id')
  @RequirePermissions(P.SCHEDULES_MANAGE)
  @ApiOperation({ summary: 'End (validTo) or re-open (null) an assignment; past days keep their schedule' })
  updateAssignment(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateAssignmentDto): Promise<ScheduleAssignmentDto> {
    return this.schedules.updateAssignment(user, id, body.validTo ?? null);
  }

  @Delete('schedules/assignments/:id')
  @HttpCode(204)
  @RequirePermissions(P.SCHEDULES_MANAGE)
  @ApiOperation({ summary: 'Delete an assignment that has not started yet (409 once in effect: end it instead)' })
  deleteAssignment(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.schedules.deleteAssignment(user, id);
  }

  @Get('schedules/employees/:id/current')
  @RequireAnyPermission(P.SCHEDULES_MANAGE, P.ATTENDANCE_READ_TEAM, P.ATTENDANCE_READ_ALL, P.ATTENDANCE_SELF)
  @ApiOperation({ summary: 'The schedule in force for an employee on a date (default today) and where it comes from' })
  current(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: CurrentScheduleQueryDto): Promise<EmployeeScheduleDto> {
    return this.schedules.current(user, id, q.date);
  }

  @Get('schedules/:id/assignments')
  @RequireAnyPermission(P.SCHEDULES_MANAGE, P.ATTENDANCE_READ_TEAM, P.ATTENDANCE_READ_ALL)
  @ApiOperation({ summary: 'List assignments of a schedule (department managers: only their departments and their employees)' })
  assignments(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<ScheduleAssignmentDto[]> {
    return this.schedules.listAssignments(user, id);
  }

  @Post('schedules/:id/assignments')
  @RequirePermissions(P.SCHEDULES_MANAGE)
  @ApiOperation({ summary: 'Assign a schedule to an employee or a department for a date range' })
  assign(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: CreateAssignmentDto): Promise<ScheduleAssignmentDto> {
    return this.schedules.assign(user, id, body);
  }

  @Get('holidays')
  @RequireAnyPermission(P.SCHEDULES_MANAGE, P.ATTENDANCE_READ_TEAM, P.ATTENDANCE_READ_ALL)
  @ApiOperation({ summary: 'List holidays (optionally for one year)' })
  holidays(@Query() q: HolidayQueryDto): Promise<HolidayDto[]> {
    return this.schedules.listHolidays(q.year);
  }

  @Post('holidays')
  @RequirePermissions(P.SCHEDULES_MANAGE)
  @ApiOperation({ summary: 'Add a holiday' })
  createHoliday(@CurrentUser() user: AuthUser, @Body() body: CreateHolidayDto): Promise<HolidayDto> {
    return this.schedules.createHoliday(user, body);
  }

  @Post('holidays/range')
  @RequirePermissions(P.SCHEDULES_MANAGE)
  @ApiOperation({ summary: 'Add a holiday spanning several days (one entry per date, at most 31)' })
  createHolidayRange(@CurrentUser() user: AuthUser, @Body() body: CreateHolidayRangeDto): Promise<HolidayDto[]> {
    return this.schedules.createHolidayRange(user, body);
  }

  @Patch('holidays/:id')
  @RequirePermissions(P.SCHEDULES_MANAGE)
  @ApiOperation({ summary: 'Rename a holiday or change whether it is paid' })
  updateHoliday(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateHolidayDto): Promise<HolidayDto> {
    return this.schedules.updateHoliday(user, id, body);
  }

  @Delete('holidays/:id')
  @RequirePermissions(P.SCHEDULES_MANAGE)
  @ApiOperation({ summary: 'Delete a holiday' })
  deleteHoliday(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<{ ok: true }> {
    return this.schedules.deleteHoliday(user, id);
  }
}
