import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean, IsInt, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateNested,
} from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class DeviceLocationDto {
  @ApiProperty({ example: 31.9539 }) @IsNumber({ allowNaN: false, allowInfinity: false }) @IsLatitude() latitude!: number;
  @ApiProperty({ example: 35.9106 }) @IsNumber({ allowNaN: false, allowInfinity: false }) @IsLongitude() longitude!: number;
  @ApiProperty({ example: 12, description: 'Accuracy radius reported by the device, metres' })
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(100_000) accuracy!: number;
}

export class AttendanceActionDto {
  @ApiProperty({ format: 'uuid', description: 'Client-generated; replaying the same key returns the current status without new rows' })
  @IsUUID() idempotencyKey!: string;

  @ApiPropertyOptional({ type: DeviceLocationDto, description: 'Device location; required for check-in and check-out' })
  @IsOptional() @ValidateNested() @Type(() => DeviceLocationDto) location?: DeviceLocationDto;
}

export class BreakStartDto extends AttendanceActionDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() breakTypeId!: string;
}

export class DateRangeQueryDto {
  @ApiPropertyOptional({ example: '2026-10-01', description: 'Local date (Asia/Amman); default first day of the month of `to`' })
  @IsOptional() @Matches(DATE_RE) from?: string;
  @ApiPropertyOptional({ example: '2026-10-17', description: 'Local date; default today' })
  @IsOptional() @Matches(DATE_RE) to?: string;
}

export class EventsQueryDto extends DateRangeQueryDto {
  @ApiPropertyOptional({ default: 1, maximum: 100000 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page?: number;
  @ApiPropertyOptional({ default: 50, maximum: 200 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
}

export class BreakTypesQueryDto {
  @ApiPropertyOptional({ description: 'Include inactive types (requires break_types.manage)' })
  @IsOptional() @Type(() => String) @IsString() includeInactive?: string;
}

export class CreateBreakTypeDto {
  @ApiProperty({ example: 'PRAYER' }) @IsString() @Length(1, 40) @Matches(/^[A-Z0-9_]+$/) code!: string;
  @ApiProperty() @IsString() @Length(1, 120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) nameAr?: string;
  @ApiPropertyOptional({ nullable: true, type: Number }) @IsOptional() @IsInt() @Min(1) @Max(1440) maxMinutes?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPaid?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() requiresApproval?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() countsAsWork?: boolean;
  @ApiPropertyOptional({ nullable: true, type: Number }) @IsOptional() @IsInt() @Min(1) @Max(1440) notifyAfterMinutes?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class UpdateBreakTypeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) name?: string;
  @ApiPropertyOptional({ nullable: true, type: String }) @IsOptional() @IsString() @Length(1, 120) nameAr?: string | null;
  @ApiPropertyOptional({ nullable: true, type: Number }) @IsOptional() @IsInt() @Min(1) @Max(1440) maxMinutes?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPaid?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() requiresApproval?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() countsAsWork?: boolean;
  @ApiPropertyOptional({ nullable: true, type: Number }) @IsOptional() @IsInt() @Min(1) @Max(1440) notifyAfterMinutes?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}
