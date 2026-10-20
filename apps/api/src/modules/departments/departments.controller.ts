import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DepartmentDto, PERMISSIONS } from '@workforce/shared';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth';
import { CreateDepartmentDto, UpdateDepartmentDto } from './departments.dto';
import { DepartmentsService } from './departments.service';

@ApiTags('Departments')
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.EMPLOYEES_READ)
  @ApiOperation({ summary: 'Departments with active employee counts' })
  list(): Promise<DepartmentDto[]> {
    return this.departments.list();
  }

  @Post()
  @RequirePermissions(PERMISSIONS.DEPARTMENTS_MANAGE)
  @ApiOperation({ summary: 'Create a department' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDepartmentDto): Promise<DepartmentDto> {
    return this.departments.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.DEPARTMENTS_MANAGE)
  @ApiOperation({ summary: 'Update a department' })
  update(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateDepartmentDto): Promise<DepartmentDto> {
    return this.departments.update(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.DEPARTMENTS_MANAGE)
  @ApiOperation({ summary: 'Soft-delete a department (refused while it has active employees)' })
  remove(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    return this.departments.remove(user, id);
  }
}
