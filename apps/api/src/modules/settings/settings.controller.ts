import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Allow, IsInt, Matches } from 'class-validator';
import { PERMISSIONS, SettingDto, type CurrentWorkHoursDto, type WorkHoursRuleDto } from '@workforce/shared';
import { AuthUser, CurrentUser, RequireAnyPermission, RequirePermissions } from '../../common/auth';
import { SettingsService } from './settings.service';
import { WorkHoursService } from './work-hours.service';

export class UpdateSettingDto {
  @ApiProperty({ description: 'New value; type and range depend on the key' })
  @Allow()
  value!: unknown;
}

export class CreateWorkHoursRuleDto {
  @ApiProperty({ example: '2026-10-28', description: 'First day the rule applies (company calendar)' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'effectiveFrom must be YYYY-MM-DD' })
  effectiveFrom!: string;

  @ApiProperty({ example: 540, description: 'Daily requirement in minutes, break included (30-1440)' })
  @IsInt()
  dailyRequiredMinutes!: number;

  @ApiProperty({ example: 60, description: 'Break allowance inside the day in minutes (0-240, at most the daily requirement)' })
  @IsInt()
  includedBreakMinutes!: number;
}

@ApiTags('Settings')
@Controller('settings')
@RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
export class SettingsController {
  constructor(private readonly settings: SettingsService, private readonly workHours: WorkHoursService) {}

  @Get()
  @ApiOperation({ summary: 'All known settings with their effective values' })
  list(): Promise<SettingDto[]> {
    return this.settings.list();
  }

  @Get('work-hours')
  @ApiOperation({ summary: 'Company work-hours rules, oldest first' })
  listWorkHours(): Promise<WorkHoursRuleDto[]> {
    return this.workHours.list();
  }

  @Get('work-hours/current')
  @RequireAnyPermission(PERMISSIONS.SETTINGS_MANAGE, PERMISSIONS.EMPLOYEES_READ, PERMISSIONS.EMPLOYEES_MANAGE)
  @ApiOperation({ summary: 'Company work hours in force today' })
  currentWorkHours(): Promise<CurrentWorkHoursDto> {
    return this.workHours.current();
  }

  @Post('work-hours')
  @ApiOperation({ summary: 'Add a work-hours rule from a date on, or replace the rule with the same date (audited)' })
  setWorkHours(@Body() body: CreateWorkHoursRuleDto, @CurrentUser() user: AuthUser): Promise<WorkHoursRuleDto> {
    return this.workHours.set(body, user);
  }

  @Delete('work-hours/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a work-hours rule (not the earliest one; audited)' })
  async deleteWorkHours(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<void> {
    await this.workHours.remove(id, user);
  }

  @Patch(':key')
  @ApiOperation({ summary: 'Change one setting (validated per key, audited)' })
  update(@Param('key') key: string, @Body() body: UpdateSettingDto, @CurrentUser() user: AuthUser): Promise<SettingDto> {
    return this.settings.update(key, body.value, user.userId, user.ip);
  }
}
