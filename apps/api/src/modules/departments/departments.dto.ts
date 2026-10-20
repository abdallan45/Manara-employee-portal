import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';

const trimUpper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToNull = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value.trim() : value);

export class CreateDepartmentDto {
  @ApiProperty({ example: 'ENG' })
  @Transform(trimUpper) @IsString() @Matches(/^[A-Z0-9_-]{2,32}$/, { message: 'code must be 2-32 chars of A-Z, 0-9, underscore or dash' })
  code!: string;

  @ApiProperty({ example: 'Engineering' })
  @Transform(trim) @IsString() @Length(1, 120)
  name!: string;

  @ApiPropertyOptional({ nullable: true, example: 'الهندسة' })
  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(120)
  nameAr?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @Transform(emptyToNull) @IsOptional() @IsUUID()
  parentId?: string | null;
}

export class UpdateDepartmentDto extends PartialType(CreateDepartmentDto) {}
