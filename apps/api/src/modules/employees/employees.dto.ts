import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize, ArrayUnique, IsArray, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/http/pagination';
import { PASSWORD_MAX, PASSWORD_MIN } from '../auth/password';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const trimLower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
/** Empty strings from forms mean "clear this field". */
const emptyToNull = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value.trim() : value);

export const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

export class EmployeeListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Matches employee code, name, Arabic name or username' })
  @IsOptional() @IsString() @MaxLength(100) @Transform(trim)
  search?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional({ enum: ['active', 'inactive', 'all'], default: 'active' })
  @IsOptional() @IsIn(['active', 'inactive', 'all'])
  status: 'active' | 'inactive' | 'all' = 'active';
}

export class CreateEmployeeDto {
  @ApiProperty({ example: 'EMP-0042' })
  @Transform(trim) @IsString() @Matches(/^[A-Za-z0-9._-]{1,32}$/, { message: 'employeeCode may contain letters, digits, dot, underscore and dash (max 32)' })
  employeeCode!: string;

  @ApiProperty() @Transform(trim) @IsString() @Length(1, 200)
  fullName!: string;

  @ApiPropertyOptional({ nullable: true }) @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(200)
  fullNameAr?: string | null;

  @ApiPropertyOptional({ nullable: true }) @Transform(emptyToNull) @IsOptional() @IsEmail() @MaxLength(254)
  email?: string | null;

  @ApiPropertyOptional({ nullable: true }) @Transform(emptyToNull) @IsOptional() @IsString() @Matches(/^[+0-9 ()-]{3,32}$/, { message: 'phone must be a phone number' })
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true }) @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(120)
  jobTitle?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true }) @Transform(emptyToNull) @IsOptional() @IsUUID()
  departmentId?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true }) @Transform(emptyToNull) @IsOptional() @IsUUID()
  managerId?: string | null;

  @ApiPropertyOptional({ example: '2026-01-15', nullable: true })
  @Transform(emptyToNull) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'hireDate must be YYYY-MM-DD' })
  hireDate?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 540, description: 'Daily requirement in minutes, break included (30-1440); null = company default' })
  @Transform(emptyToNull) @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt()
  dailyRequiredMinutes?: number | null;

  @ApiPropertyOptional({ nullable: true, example: 60, description: 'Break allowance inside the day in minutes (0-240); null = company default' })
  @Transform(emptyToNull) @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt()
  includedBreakMinutes?: number | null;

  @ApiPropertyOptional({ type: [String], description: 'User ids of the supervisors (project managers); replaces the list on update' })
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(20) @IsUUID('all', { each: true })
  supervisorUserIds?: string[];

  @ApiProperty({ example: 'j.doe', pattern: USERNAME_PATTERN.source })
  @Transform(trimLower) @IsString() @Matches(USERNAME_PATTERN, { message: 'username must be 3-32 chars of a-z, 0-9, dot, underscore or dash' })
  username!: string;

  @ApiProperty({ minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX, format: 'password' })
  @IsString() @Length(PASSWORD_MIN, PASSWORD_MAX)
  password!: string;

  @ApiPropertyOptional({ type: [String], example: ['EMPLOYEE'], description: "Role keys; defaults to ['EMPLOYEE']" })
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(20) @IsString({ each: true })
  roleKeys?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Departments this user manages (requires DEPARTMENT_MANAGER)' })
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(50) @IsUUID('all', { each: true })
  managedDepartmentIds?: string[];
}

/** Partial update. For nullable fields, null clears the value and an absent field leaves it unchanged. */
export class UpdateEmployeeDto extends PartialType(CreateEmployeeDto) {}
