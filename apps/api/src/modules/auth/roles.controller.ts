import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ALL_PERMISSIONS, PERMISSIONS, type CreateRoleInput, type RoleDto, type UpdateRoleInput } from '@workforce/shared';
import { ArrayMaxSize, ArrayUnique, IsArray, IsOptional, IsString, Length, Matches } from 'class-validator';
import { AuthUser, CurrentUser, RequireAnyPermission, RequirePermissions } from '../../common/auth';
import { ROLE_KEY_PATTERN, RolesService } from './roles.service';

const uuid = new ParseUUIDPipe({ version: undefined });

export class UpdateRoleDto implements UpdateRoleInput {
  @ApiPropertyOptional({ example: 'Project Manager' }) @IsOptional() @IsString() @Length(1, 80) name?: string;
  @ApiPropertyOptional({ nullable: true, type: String, example: 'مدير مشروع' }) @IsOptional() @IsString() @Length(0, 80) nameAr?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) @IsOptional() @IsString() @Length(0, 500) description?: string | null;
  @ApiPropertyOptional({ type: [String], description: 'The complete permission set (replaces the current one)' })
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(ALL_PERMISSIONS.length) @IsString({ each: true }) permissions?: string[];
}

export class CreateRoleDto implements CreateRoleInput {
  @ApiProperty({ example: 'SITE_SUPERVISOR', description: 'A-Z, 0-9 and _, starting with a letter; cannot be changed later' })
  @IsString() @Matches(ROLE_KEY_PATTERN, { message: 'key must be 2-40 characters: A-Z, 0-9 and _, starting with a letter' }) key!: string;
  @ApiProperty({ example: 'Site supervisor' }) @IsString() @Length(1, 80) name!: string;
  @ApiPropertyOptional({ nullable: true, type: String }) @IsOptional() @IsString() @Length(0, 80) nameAr?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) @IsOptional() @IsString() @Length(0, 500) description?: string | null;
  @ApiProperty({ type: [String], example: ['attendance.self', 'leave.self', 'overtime.self'] })
  @IsArray() @ArrayUnique() @ArrayMaxSize(ALL_PERMISSIONS.length) @IsString({ each: true }) permissions!: string[];
}

@ApiTags('Roles')
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  // Also read by the employee dialog (role checkboxes) and the approval-chain editors in settings.
  @RequireAnyPermission(PERMISSIONS.EMPLOYEES_READ, PERMISSIONS.ROLES_MANAGE, PERMISSIONS.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Roles with their permission keys and number of active users' })
  list(): Promise<RoleDto[]> {
    return this.roles.list();
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ROLES_MANAGE)
  @ApiOperation({ summary: 'Create a custom role; audited' })
  create(@CurrentUser() user: AuthUser, @Body() body: CreateRoleDto): Promise<RoleDto> {
    return this.roles.create(user, body);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ROLES_MANAGE)
  @ApiOperation({ summary: 'Rename a role or change its permissions (SUPER_ADMIN keeps every permission); applies at once; audited' })
  update(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body() body: UpdateRoleDto): Promise<RoleDto> {
    return this.roles.update(user, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.ROLES_MANAGE)
  @ApiOperation({ summary: 'Delete a custom role (409 while users hold it or an approval chain uses it); audited' })
  async remove(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<void> {
    await this.roles.remove(user, id);
  }
}
