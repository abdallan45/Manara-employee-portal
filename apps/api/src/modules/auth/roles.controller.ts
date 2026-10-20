import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, RoleDto } from '@workforce/shared';
import { RequireAnyPermission } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';

@ApiTags('Roles')
@Controller('roles')
export class RolesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequireAnyPermission(PERMISSIONS.EMPLOYEES_READ, PERMISSIONS.ROLES_MANAGE)
  @ApiOperation({ summary: 'Roles with their permission keys' })
  async list(): Promise<RoleDto[]> {
    const roles = await this.prisma.role.findMany({
      orderBy: { createdAt: 'asc' },
      include: { permissions: { include: { permission: { select: { key: true } } } } },
    });
    return roles.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      permissions: r.permissions.map((p) => p.permission.key).sort(),
    }));
  }
}
