import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Location } from '@prisma/client';
import { PERMISSIONS, type OfficeLocationDto } from '@workforce/shared';
import { AppError } from '../../common/app-error';
import { CurrentUser, RequirePermissions, type AuthUser } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { GeofenceService } from './geofence.service';
import { CreateOfficeDto, UpdateOfficeDto } from './offices.dto';

const toDto = (l: Location): OfficeLocationDto => ({
  id: l.id, name: l.name, address: l.address, latitude: l.latitude, longitude: l.longitude,
  radiusMeters: l.radiusMeters, isActive: l.isActive, createdAt: l.createdAt.toISOString(),
});

const needsCoordinates = () =>
  AppError.badRequest('VALIDATION_FAILED', 'Set the office coordinates before activating it', [{ field: 'latitude', messages: ['latitude and longitude are required'] }]);

@ApiTags('Offices')
@Controller('offices')
@RequirePermissions(PERMISSIONS.OFFICES_MANAGE)
export class OfficesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly geofence: GeofenceService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List offices (check-in / check-out geofences)' })
  async list(): Promise<OfficeLocationDto[]> {
    return (await this.prisma.location.findMany({ orderBy: { createdAt: 'asc' } })).map(toDto);
  }

  @Post()
  @ApiOperation({ summary: 'Add an office' })
  async create(@CurrentUser() user: AuthUser, @Body() body: CreateOfficeDto): Promise<OfficeLocationDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.location.create({
        data: {
          name: body.name.trim(), address: body.address?.trim() || null, latitude: body.latitude, longitude: body.longitude,
          radiusMeters: body.radiusMeters ?? 150, isActive: body.isActive ?? true,
        },
      });
      await this.audit.record(tx, { actorUserId: user.userId, action: 'OFFICE_CREATE', entityType: 'Location', entityId: created.id, after: toDto(created), ipAddress: user.ip });
      return created;
    });
    this.geofence.invalidate();
    return toDto(row);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an office' })
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateOfficeDto): Promise<OfficeLocationDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      const before = await tx.location.findUnique({ where: { id } });
      if (!before) throw AppError.notFound('Office not found');
      const latitude = body.latitude ?? before.latitude;
      const longitude = body.longitude ?? before.longitude;
      if ((body.isActive ?? before.isActive) && (latitude === null || longitude === null)) throw needsCoordinates();
      const updated = await tx.location.update({
        where: { id },
        data: {
          name: body.name?.trim(), address: body.address === undefined ? undefined : body.address?.trim() || null,
          latitude: body.latitude, longitude: body.longitude, radiusMeters: body.radiusMeters, isActive: body.isActive,
        },
      });
      await this.audit.record(tx, { actorUserId: user.userId, action: 'OFFICE_UPDATE', entityType: 'Location', entityId: id, before: toDto(before), after: toDto(updated), ipAddress: user.ip });
      return updated;
    });
    this.geofence.invalidate();
    return toDto(row);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an office (409 when employees, holidays or attendance events use it; deactivate it instead)' })
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<{ ok: true }> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.location.findUnique({ where: { id } });
      if (!before) throw AppError.notFound('Office not found');
      const [employees, holidays, events] = await Promise.all([
        tx.employee.count({ where: { locationId: id }, take: 1 }),
        tx.holiday.count({ where: { locationId: id }, take: 1 }),
        tx.attendanceEvent.count({ where: { officeId: id }, take: 1 }),
      ]);
      if (employees || holidays || events) throw AppError.conflict('CONFLICT', 'This office is in use; deactivate it instead', { id });
      await tx.location.delete({ where: { id } });
      await this.audit.record(tx, { actorUserId: user.userId, action: 'OFFICE_DELETE', entityType: 'Location', entityId: id, before: toDto(before), ipAddress: user.ip });
    });
    this.geofence.invalidate();
    return { ok: true };
  }
}
