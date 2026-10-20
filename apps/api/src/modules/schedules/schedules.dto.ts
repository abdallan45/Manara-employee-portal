import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateNested,
} from 'class-validator';

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class ScheduleDayInput {
  @ApiProperty({ minimum: 0, maximum: 6, description: '0 = Sunday … 6 = Saturday' }) @IsInt() @Min(0) @Max(6) weekday!: number;
  @ApiProperty() @IsBoolean() isWorkday!: boolean;
  @ApiPropertyOptional({ nullable: true, type: Number, description: 'Minutes after local midnight' })
  @IsOptional() @IsInt() @Min(0) @Max(1439) startMinute?: number | null;
  @ApiPropertyOptional({ nullable: true, type: Number, description: 'Less than startMinute = ends next day' })
  @IsOptional() @IsInt() @Min(0) @Max(1439) endMinute?: number | null;
  @ApiProperty() @IsInt() @Min(0) @Max(1440) requiredMinutes!: number;
}

export class CreateScheduleDto {
  @ApiProperty() @IsString() @Length(1, 120) name!: string;
  @ApiProperty({ enum: ['FIXED', 'FLEXIBLE'] }) @IsIn(['FIXED', 'FLEXIBLE']) type!: 'FIXED' | 'FLEXIBLE';
  @ApiPropertyOptional({ default: 10 }) @IsOptional() @IsInt() @Min(0) @Max(240) graceMinutes?: number;
  @ApiPropertyOptional({ default: 0, example: 60, description: 'Break time included in the day: only breaks beyond it are deducted' })
  @IsOptional() @IsInt() @Min(0) @Max(240) includedBreakMinutes?: number;
  @ApiPropertyOptional({ nullable: true, type: Number }) @IsOptional() @IsInt() @Min(0) @Max(1439) coreStartMinute?: number | null;
  @ApiPropertyOptional({ nullable: true, type: Number }) @IsOptional() @IsInt() @Min(0) @Max(1439) coreEndMinute?: number | null;
  @ApiPropertyOptional({ description: 'Defaults to the sum of the days’ requiredMinutes' })
  @IsOptional() @IsInt() @Min(0) @Max(10080) weeklyRequiredMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
  @ApiProperty({ type: [ScheduleDayInput] })
  @IsArray() @ArrayMaxSize(7) @ValidateNested({ each: true }) @Type(() => ScheduleDayInput) days!: ScheduleDayInput[];
}

export class UpdateScheduleDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) name?: string;
  @ApiPropertyOptional({ enum: ['FIXED', 'FLEXIBLE'] }) @IsOptional() @IsIn(['FIXED', 'FLEXIBLE']) type?: 'FIXED' | 'FLEXIBLE';
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(240) graceMinutes?: number;
  @ApiPropertyOptional({ example: 60 }) @IsOptional() @IsInt() @Min(0) @Max(240) includedBreakMinutes?: number;
  @ApiPropertyOptional({ nullable: true, type: Number }) @IsOptional() @IsInt() @Min(0) @Max(1439) coreStartMinute?: number | null;
  @ApiPropertyOptional({ nullable: true, type: Number }) @IsOptional() @IsInt() @Min(0) @Max(1439) coreEndMinute?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(10080) weeklyRequiredMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
  @ApiPropertyOptional({ type: [ScheduleDayInput], description: 'Replaces all days when given' })
  @IsOptional() @IsArray() @ArrayMaxSize(7) @ValidateNested({ each: true }) @Type(() => ScheduleDayInput) days?: ScheduleDayInput[];
}

export class CreateAssignmentDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() employeeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
  @ApiProperty({ example: '2026-11-01' }) @Matches(DATE_RE) validFrom!: string;
  @ApiPropertyOptional({ nullable: true, type: String }) @IsOptional() @Matches(DATE_RE) validTo?: string | null;
}

export class UpdateAssignmentDto {
  @ApiProperty({ nullable: true, type: String, example: '2026-12-31', description: 'Last day the assignment applies; null = open-ended' })
  @IsOptional() @Matches(DATE_RE) validTo!: string | null;
}

export class CurrentScheduleQueryDto {
  @ApiPropertyOptional({ example: '2026-10-18', description: 'Default: today' }) @IsOptional() @Matches(DATE_RE) date?: string;
}

export class CreateHolidayRangeDto {
  @ApiProperty({ example: '2027-03-09' }) @Matches(DATE_RE) from!: string;
  @ApiProperty({ example: '2027-03-12', description: 'Inclusive; at most 31 days after `from`' }) @Matches(DATE_RE) to!: string;
  @ApiProperty() @IsString() @Length(1, 120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) nameAr?: string;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() isPaid?: boolean;
}

export class UpdateHolidayDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) name?: string;
  @ApiPropertyOptional({ nullable: true, type: String }) @IsOptional() @IsString() @Length(0, 120) nameAr?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPaid?: boolean;
}

export class HolidayQueryDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2100) year?: number;
}

export class CreateHolidayDto {
  @ApiProperty({ example: '2026-12-25' }) @Matches(DATE_RE) date!: string;
  @ApiProperty() @IsString() @Length(1, 120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) nameAr?: string;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() isPaid?: boolean;
  @ApiPropertyOptional({ nullable: true, type: String }) @IsOptional() @IsUUID() locationId?: string | null;
}
