import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OFFICE_RADIUS_RANGE } from '@workforce/shared';
import { IsBoolean, IsInt, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class CreateOfficeDto {
  @ApiProperty({ example: 'Head office' }) @IsString() @Length(1, 120) name!: string;
  @ApiPropertyOptional({ nullable: true, type: String }) @IsOptional() @IsString() @Length(0, 300) address?: string | null;
  @ApiProperty({ example: 31.9539 }) @IsNumber({ allowNaN: false, allowInfinity: false }) @IsLatitude() latitude!: number;
  @ApiProperty({ example: 35.9106 }) @IsNumber({ allowNaN: false, allowInfinity: false }) @IsLongitude() longitude!: number;
  @ApiPropertyOptional({ default: 150, minimum: OFFICE_RADIUS_RANGE.min, maximum: OFFICE_RADIUS_RANGE.max })
  @IsOptional() @IsInt() @Min(OFFICE_RADIUS_RANGE.min) @Max(OFFICE_RADIUS_RANGE.max) radiusMeters?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateOfficeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) name?: string;
  @ApiPropertyOptional({ nullable: true, type: String }) @IsOptional() @IsString() @Length(0, 300) address?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false }) @IsLatitude() latitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false }) @IsLongitude() longitude?: number;
  @ApiPropertyOptional({ minimum: OFFICE_RADIUS_RANGE.min, maximum: OFFICE_RADIUS_RANGE.max })
  @IsOptional() @IsInt() @Min(OFFICE_RADIUS_RANGE.min) @Max(OFFICE_RADIUS_RANGE.max) radiusMeters?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
