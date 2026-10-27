import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateNested,
} from 'class-validator';
import { MAX_APPROVAL_STEPS } from '@workforce/shared';
import type {
  ApprovalTab, CorrectionKind, CreateCorrectionInput, CreateLeaveRequestInput, DirectCorrectionInput, CreateLeaveTypeInput, CreateOvertimeRequestInput, HalfDay,
  DirectOvertimeInput, LeaveAccrual, LeaveMode, LeaveUnit, OvertimeCompensation, RequestKind, RequestStatus, SetLeaveEntitlementInput, UpdateLeaveTypeInput,
  UpdateOvertimePolicyInput,
} from '@workforce/shared';
import { PaginationQueryDto } from '../../common/http/pagination';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUSES: RequestStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];

export class StatusQueryDto {
  @ApiPropertyOptional({ enum: STATUSES }) @IsOptional() @IsIn(STATUSES) status?: RequestStatus;
}

// ───────────── Leave ─────────────

export class LeaveRequestBodyDto implements CreateLeaveRequestInput {
  @ApiProperty({ format: 'uuid' }) @IsUUID() leaveTypeId!: string;
  @ApiProperty({ enum: ['FULL_DAY', 'HALF_DAY', 'HOURLY'] }) @IsIn(['FULL_DAY', 'HALF_DAY', 'HOURLY']) mode!: LeaveMode;
  @ApiProperty({ example: '2026-11-01' }) @Matches(DATE_RE) startDate!: string;
  @ApiPropertyOptional({ example: '2026-11-03', description: 'FULL_DAY only; defaults to startDate' }) @IsOptional() @Matches(DATE_RE) endDate?: string;
  @ApiPropertyOptional({ enum: ['FIRST', 'SECOND'], description: 'HALF_DAY only' }) @IsOptional() @IsIn(['FIRST', 'SECOND']) half?: HalfDay;
  @ApiPropertyOptional({ example: '09:00', description: 'HOURLY only (local time)' }) @IsOptional() @Matches(TIME_RE) startTime?: string;
  @ApiPropertyOptional({ example: '11:00', description: 'HOURLY only (local time)' }) @IsOptional() @Matches(TIME_RE) endTime?: string;
  @ApiProperty({ example: 'Family visit' }) @IsString() @Length(3, 1000) reason!: string;
}

export class LeaveListQueryDto extends StatusQueryDto {
  @ApiPropertyOptional({ example: 2026 }) @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2100) year?: number;
}

export class YearQueryDto {
  @ApiPropertyOptional({ example: 2026, description: 'Default: current year' }) @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2100) year?: number;
}

export class LeaveEntitlementQueryDto {
  @ApiPropertyOptional({ example: 2026, description: 'Default: current year' }) @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2100) year?: number;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() employeeId?: string;
}

export class SetLeaveEntitlementDto implements SetLeaveEntitlementInput {
  @ApiProperty({ type: [String], format: 'uuid', description: 'One or several employees (at most 200)' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', { each: true }) employeeIds!: string[];
  @ApiProperty({ format: 'uuid' }) @IsUUID() leaveTypeId!: string;
  @ApiProperty({ example: 2026, description: 'First year it applies to; later years keep it until another entitlement starts' })
  @IsInt() @Min(2000) @Max(2100) fromYear!: number;
  @ApiProperty({ example: 10080, description: 'Minutes per year (480 per day of 8 hours)' }) @IsInt() @Min(0) @Max(366 * 480) annualEntitlementMinutes!: number;
  @ApiPropertyOptional({ example: 'Seniority: 5+ years' }) @IsOptional() @IsString() @Length(0, 300) note?: string;
}

export class LeaveAdjustmentDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() employeeId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() leaveTypeId!: string;
  @ApiProperty({ example: 2026 }) @IsInt() @Min(2000) @Max(2100) year!: number;
  @ApiProperty({ example: 480, description: 'Positive credits, negative debits (minutes)' }) @IsInt() @Min(-100000) @Max(100000) minutes!: number;
  @ApiProperty({ example: 'Opening balance' }) @IsString() @Length(3, 500) note!: string;
}

export class LeaveTypesQueryDto {
  @ApiPropertyOptional({ description: 'Include inactive types (requires settings.manage)' })
  @IsOptional() @Type(() => String) @IsString() includeInactive?: string;
}

const UNITS: LeaveUnit[] = ['DAY', 'HALF_DAY', 'HOUR'];
const ACCRUALS: LeaveAccrual[] = ['NONE', 'MONTHLY', 'YEARLY'];
/** 366 eight-hour days: far above any real entitlement, low enough to catch unit mistakes (days typed as minutes ×60). */
const MAX_LEAVE_MINUTES = 366 * 480;
const REMOTE_WORK_DOC = 'Approved requests are remote working days, not leave: the schedule applies and check-ins away from the office are accepted on those days. Requires accrual NONE and no entitlement';

const CHAIN_DOC = 'Approval chain in order: MANAGER (the employee supervisors and department managers) or role keys such as HR_ADMIN, GENERAL_MANAGER';

export class UpdateLeaveTypeDto implements UpdateLeaveTypeInput {
  @ApiPropertyOptional({ example: 'Annual leave' }) @IsOptional() @IsString() @Length(1, 120) name?: string;
  @ApiPropertyOptional({ nullable: true, type: String, example: 'إجازة سنوية' }) @IsOptional() @IsString() @Length(0, 120) nameAr?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPaid?: boolean;
  @ApiPropertyOptional({ enum: UNITS, description: 'DAY allows full and half days; HALF_DAY only half days; HOUR only hourly requests' })
  @IsOptional() @IsIn(UNITS) unit?: LeaveUnit;
  @ApiPropertyOptional({ enum: ACCRUALS, description: 'YEARLY grants the entitlement when the year opens (pro-rated in the hire year); MONTHLY posts 1/12 per month; NONE keeps no balance' })
  @IsOptional() @IsIn(ACCRUALS) accrual?: LeaveAccrual;
  @ApiPropertyOptional({ example: 6720, description: 'Minutes per year (480 per day); must be 0 when accrual is NONE' })
  @IsOptional() @IsInt() @Min(0) @Max(MAX_LEAVE_MINUTES) annualEntitlementMinutes?: number;
  @ApiPropertyOptional({ example: 3360, description: 'Most minutes carried into the next year (0 = none)' })
  @IsOptional() @IsInt() @Min(0) @Max(MAX_LEAVE_MINUTES) carryoverMaxMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() requiresAttachment?: boolean;
  @ApiPropertyOptional({ type: [String], example: ['MANAGER', 'HR_ADMIN'], description: CHAIN_DOC })
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_APPROVAL_STEPS) @IsString({ each: true }) approvalSteps?: string[];
  @ApiPropertyOptional({ description: 'Sensitive types skip the manager step and are masked for managers' }) @IsOptional() @IsBoolean() isSensitive?: boolean;
  @ApiPropertyOptional({ description: REMOTE_WORK_DOC }) @IsOptional() @IsBoolean() isRemoteWork?: boolean;
  @ApiPropertyOptional({ description: 'false deactivates: hidden from new requests and balances; history is kept' }) @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateLeaveTypeDto implements CreateLeaveTypeInput {
  @ApiProperty({ example: 'ANNUAL', description: 'A-Z, 0-9 and _; cannot be changed later' }) @IsString() @Length(1, 40) @Matches(/^[A-Z0-9_]+$/) code!: string;
  @ApiProperty({ example: 'Annual leave' }) @IsString() @Length(1, 120) name!: string;
  @ApiPropertyOptional({ nullable: true, type: String, example: 'إجازة سنوية' }) @IsOptional() @IsString() @Length(0, 120) nameAr?: string | null;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() isPaid?: boolean;
  @ApiProperty({ enum: UNITS }) @IsIn(UNITS) unit!: LeaveUnit;
  @ApiProperty({ enum: ACCRUALS }) @IsIn(ACCRUALS) accrual!: LeaveAccrual;
  @ApiPropertyOptional({ example: 6720, default: 0 }) @IsOptional() @IsInt() @Min(0) @Max(MAX_LEAVE_MINUTES) annualEntitlementMinutes?: number;
  @ApiPropertyOptional({ example: 3360, default: 0 }) @IsOptional() @IsInt() @Min(0) @Max(MAX_LEAVE_MINUTES) carryoverMaxMinutes?: number;
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() requiresAttachment?: boolean;
  @ApiPropertyOptional({ type: [String], default: ['MANAGER'], description: CHAIN_DOC })
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_APPROVAL_STEPS) @IsString({ each: true }) approvalSteps?: string[];
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() isSensitive?: boolean;
  @ApiPropertyOptional({ default: false, description: REMOTE_WORK_DOC }) @IsOptional() @IsBoolean() isRemoteWork?: boolean;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() isActive?: boolean;
}

// ───────────── Overtime ─────────────

export class OvertimeRequestBodyDto implements CreateOvertimeRequestInput {
  @ApiProperty({ example: '2026-10-15' }) @Matches(DATE_RE) workDate!: string;
  @ApiProperty({ example: 90 }) @IsInt() @Min(1) @Max(1440) minutes!: number;
  @ApiPropertyOptional({ enum: ['PAY', 'TIME_OFF'], default: 'PAY' }) @IsOptional() @IsIn(['PAY', 'TIME_OFF']) compensation?: OvertimeCompensation;
  @ApiProperty({ example: 'Release deadline' }) @IsString() @Length(3, 1000) reason!: string;
}

export class OvertimeCandidatesQueryDto {
  @ApiPropertyOptional({ example: '2026-10-01', description: 'Default: first day of the month of `to`' }) @IsOptional() @Matches(DATE_RE) from?: string;
  @ApiPropertyOptional({ example: '2026-10-17', description: 'Default: yesterday (days that have not ended are left out)' }) @IsOptional() @Matches(DATE_RE) to?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'Only this employee (still limited to my scope)' }) @IsOptional() @IsUUID() employeeId?: string;
}

class DirectOvertimeItemDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() employeeId!: string;
  @ApiProperty({ example: '2026-10-15' }) @Matches(DATE_RE) workDate!: string;
  @ApiPropertyOptional({ example: 60, description: 'Default: the recorded extra time; past days are capped at it' }) @IsOptional() @IsInt() @Min(1) @Max(1440) minutes?: number;
}

export class DirectOvertimeDto implements DirectOvertimeInput {
  @ApiProperty({ type: [DirectOvertimeItemDto] })
  @ValidateNested({ each: true }) @Type(() => DirectOvertimeItemDto) @ArrayMinSize(1) @ArrayMaxSize(200) items!: DirectOvertimeItemDto[];
  @ApiPropertyOptional({ enum: ['PAY', 'TIME_OFF'], default: 'PAY' }) @IsOptional() @IsIn(['PAY', 'TIME_OFF']) compensation?: OvertimeCompensation;
  @ApiPropertyOptional({ example: 'Stock count' }) @IsOptional() @IsString() @Length(0, 1000) comment?: string;
}

const MULTIPLIER_RE = /^\d{1,2}(\.\d{1,2})?$/;
export class UpdateOvertimePolicyDto implements UpdateOvertimePolicyInput {
  @ApiPropertyOptional({ example: '1.25' }) @IsOptional() @Matches(MULTIPLIER_RE) regularMultiplier?: string;
  @ApiPropertyOptional({ example: '1.50' }) @IsOptional() @Matches(MULTIPLIER_RE) weekendMultiplier?: string;
  @ApiPropertyOptional({ example: '1.50' }) @IsOptional() @Matches(MULTIPLIER_RE) holidayMultiplier?: string;
  @ApiPropertyOptional({ example: 15 }) @IsOptional() @IsInt() @Min(1) @Max(480) minimumMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() requiresPreApproval?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowRetroApproval?: boolean;
  @ApiPropertyOptional({ nullable: true, type: String }) @IsOptional() @IsString() @Length(0, 2000) notes?: string | null;
}

// ───────────── Corrections ─────────────

export class CorrectionBodyDto implements CreateCorrectionInput {
  @ApiProperty({ enum: ['MISSING_CHECK_IN', 'MISSING_CHECK_OUT', 'WRONG_TIME'] })
  @IsIn(['MISSING_CHECK_IN', 'MISSING_CHECK_OUT', 'WRONG_TIME']) kind!: CorrectionKind;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() workSessionId?: string;
  @ApiPropertyOptional({ enum: ['CHECK_IN', 'CHECK_OUT'], description: 'WRONG_TIME only' }) @IsOptional() @IsIn(['CHECK_IN', 'CHECK_OUT']) eventType?: 'CHECK_IN' | 'CHECK_OUT';
  @ApiProperty({ example: '2026-10-14T17:05', description: 'ISO instant or local wall time (Asia/Amman)' }) @IsString() @Length(16, 40) proposedTime!: string;
  @ApiPropertyOptional({ example: '2026-10-14T17:05', description: 'MISSING_CHECK_IN only' }) @IsOptional() @IsString() @Length(16, 40) proposedEndTime?: string;
  @ApiProperty({ example: 'Phone battery died before I could check out' }) @IsString() @Length(3, 1000) reason!: string;
}

export class DirectCorrectionBodyDto extends CorrectionBodyDto implements DirectCorrectionInput {
  @ApiProperty({ format: 'uuid', description: 'The employee whose attendance is corrected' }) @IsUUID() employeeId!: string;
}

// ───────────── Approvals ─────────────

const KINDS: RequestKind[] = ['LEAVE', 'OVERTIME', 'CORRECTION'];
const TABS: ApprovalTab[] = ['PENDING', 'APPROVED', 'REJECTED'];

export class ApprovalListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: TABS, default: 'PENDING' }) @IsOptional() @IsIn(TABS) tab: ApprovalTab = 'PENDING';
  @ApiPropertyOptional({ enum: KINDS }) @IsOptional() @IsIn(KINDS) kind?: RequestKind;
  @ApiPropertyOptional({ format: 'uuid', description: 'Only requests of this employee (still limited to my scope)' }) @IsOptional() @IsUUID() employeeId?: string;
}

export class DecisionDto {
  @ApiPropertyOptional({ description: 'Required when rejecting' }) @IsOptional() @IsString() @Length(0, 1000) comment?: string;
}

class BulkItemDto {
  @ApiProperty({ enum: KINDS }) @IsIn(KINDS) kind!: RequestKind;
  @ApiProperty({ format: 'uuid' }) @IsUUID() id!: string;
}

export class BulkApproveDto {
  @ApiProperty({ type: [BulkItemDto] })
  @ValidateNested({ each: true }) @Type(() => BulkItemDto) @ArrayMinSize(1) @ArrayMaxSize(100) items!: BulkItemDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 1000) comment?: string;
}
