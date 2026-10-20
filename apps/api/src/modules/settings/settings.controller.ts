import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsDefined } from 'class-validator';
import { PERMISSIONS, SettingDto } from '@workforce/shared';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth';
import { SettingsService } from './settings.service';

export class UpdateSettingDto {
  @ApiProperty({ description: 'New value; type and range depend on the key' })
  @IsDefined()
  value!: unknown;
}

@ApiTags('Settings')
@Controller('settings')
@RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOperation({ summary: 'All known settings with their effective values' })
  list(): Promise<SettingDto[]> {
    return this.settings.list();
  }

  @Patch(':key')
  @ApiOperation({ summary: 'Change one setting (validated per key, audited)' })
  update(@Param('key') key: string, @Body() body: UpdateSettingDto, @CurrentUser() user: AuthUser): Promise<SettingDto> {
    return this.settings.update(key, body.value, user.userId, user.ip);
  }
}
