import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { EmployeeDto, EmployeeTeamDto, Paginated, PERMISSIONS } from '@workforce/shared';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth';
import { CreateEmployeeDto, EmployeeListQueryDto, UpdateEmployeeDto, UpdateEmployeeTeamDto } from './employees.dto';
import { EmployeesService } from './employees.service';

const uuid = new ParseUUIDPipe({ version: undefined });

@ApiTags('Employees')
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.EMPLOYEES_READ)
  @ApiOperation({ summary: 'List employees (department managers only see their departments)' })
  list(@CurrentUser() user: AuthUser, @Query() q: EmployeeListQueryDto): Promise<Paginated<EmployeeDto>> {
    return this.employees.list(user, q);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.EMPLOYEES_READ)
  @ApiOperation({ summary: 'Get one employee' })
  get(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<EmployeeDto> {
    return this.employees.get(user, id);
  }

  @Get(':id/team')
  @RequirePermissions(PERMISSIONS.EMPLOYEES_READ)
  @ApiOperation({ summary: "The employee's team as a manager: direct reports and explicitly supervised employees" })
  team(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<EmployeeTeamDto> {
    return this.employees.team(user, id);
  }

  @Put(':id/team')
  @RequirePermissions(PERMISSIONS.EMPLOYEES_MANAGE)
  @ApiOperation({ summary: "Replace the employee's direct reports and / or the employees their login supervises" })
  setTeam(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body() dto: UpdateEmployeeTeamDto): Promise<EmployeeTeamDto> {
    return this.employees.setTeam(user, id, dto);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.EMPLOYEES_MANAGE)
  @ApiOperation({ summary: 'Create an employee with a login account and roles' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateEmployeeDto): Promise<EmployeeDto> {
    return this.employees.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.EMPLOYEES_MANAGE)
  @ApiOperation({ summary: 'Update an employee; a password change signs that user out everywhere' })
  update(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body() dto: UpdateEmployeeDto): Promise<EmployeeDto> {
    return this.employees.update(user, id, dto);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.EMPLOYEES_MANAGE)
  @ApiOperation({ summary: 'Deactivate the employee and their login; revokes their sessions' })
  deactivate(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<EmployeeDto> {
    return this.employees.setActive(user, id, false);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.EMPLOYEES_MANAGE)
  @ApiOperation({ summary: 'Re-activate the employee and their login' })
  activate(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<EmployeeDto> {
    return this.employees.setActive(user, id, true);
  }
}
