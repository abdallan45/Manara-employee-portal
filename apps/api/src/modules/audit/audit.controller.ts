import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AuditLogDto, AuditVerifyResult, Paginated, PERMISSIONS } from '@workforce/shared';
import { RequirePermissions } from '../../common/auth';
import { PaginationQueryDto } from '../../common/http/pagination';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from './audit.service';

export class AuditQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) entityType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128) entityId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() actorUserId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) action?: string;
  @ApiPropertyOptional({ description: 'ISO-8601 instant (inclusive)' }) @IsOptional() @Type(() => Date) @IsDate() from?: Date;
  @ApiPropertyOptional({ description: 'ISO-8601 instant (inclusive)' }) @IsOptional() @Type(() => Date) @IsDate() to?: Date;
}

@ApiTags('Audit')
@Controller('audit-logs')
@RequirePermissions(PERMISSIONS.AUDIT_READ)
export class AuditController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'Search the audit trail (newest first)' })
  list(@Query() q: AuditQueryDto): Promise<Paginated<AuditLogDto>> {
    return this.audit.list(this.prisma, q);
  }

  @Get('verify')
  @ApiOperation({ summary: 'Recompute the hash chain and report the first broken link' })
  verify(): Promise<AuditVerifyResult> {
    return this.audit.verify(this.prisma);
  }
}
