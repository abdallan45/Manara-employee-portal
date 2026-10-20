// Contracts for leave, overtime, attendance corrections and the Approval Center.
// Durations are whole minutes; dates are YYYY-MM-DD (Asia/Amman); instants are ISO-8601 UTC strings.

export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type RequestKind = 'LEAVE' | 'OVERTIME' | 'CORRECTION';

/** Minutes in one leave day when a balance is shown in days (balances themselves are kept in minutes). */
export const STANDARD_DAY_MINUTES = 480;

// ───────────────────────────── Leave ─────────────────────────────

export type LeaveUnit = 'DAY' | 'HALF_DAY' | 'HOUR';
export type LeaveAccrual = 'NONE' | 'MONTHLY' | 'YEARLY';
export type LeaveMode = 'FULL_DAY' | 'HALF_DAY' | 'HOURLY';
export type HalfDay = 'FIRST' | 'SECOND';

/** Which request modes each leave unit allows. */
export const LEAVE_MODES_BY_UNIT: Record<LeaveUnit, LeaveMode[]> = {
  DAY: ['FULL_DAY', 'HALF_DAY'],
  HALF_DAY: ['HALF_DAY'],
  HOUR: ['HOURLY'],
};

export interface LeaveTypeDto {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  isPaid: boolean;
  unit: LeaveUnit;
  accrual: LeaveAccrual;
  annualEntitlementMinutes: number;
  carryoverMaxMinutes: number;
  requiresAttachment: boolean;
  approvalLevels: number;
  isSensitive: boolean;
  /** Approved requests are remote working days, not leave (schedule applies; check-in away from the office accepted). */
  isRemoteWork: boolean;
  /** False for types without an entitlement (unpaid, remote work…): requests are not limited by a balance. */
  tracksBalance: boolean;
  /** Inactive types are hidden from new requests; existing requests and ledgers keep them. */
  isActive: boolean;
}

/** Leave type configuration (settings.manage). Amounts are minutes; {@link STANDARD_DAY_MINUTES} per day. */
export interface CreateLeaveTypeInput {
  code: string;
  name: string;
  nameAr?: string | null;
  isPaid?: boolean;
  unit: LeaveUnit;
  accrual: LeaveAccrual;
  annualEntitlementMinutes?: number;
  carryoverMaxMinutes?: number;
  requiresAttachment?: boolean;
  approvalLevels?: number;
  isSensitive?: boolean;
  /** Requires accrual NONE and no entitlement: remote work never uses a leave balance. */
  isRemoteWork?: boolean;
  isActive?: boolean;
}

/** The code is fixed once created (audit entries and ledger notes refer to it). */
export type UpdateLeaveTypeInput = Partial<Omit<CreateLeaveTypeInput, 'code'>>;

export interface LeaveBalanceDto {
  leaveType: LeaveTypeDto;
  year: number;
  /** Ledger sums for the year (minutes). */
  accrued: number;
  carriedOver: number;
  adjusted: number;
  used: number;
  /** Ledger balance: accrued + carried over + adjustments − used. */
  balance: number;
  /** Minutes held by pending requests of this year. */
  pending: number;
  /** What a new request can still use: balance − pending. */
  available: number;
}

/**
 * What a leave ledger row records. ENTITLEMENT_CORRECTION is an accrual posted because a personal
 * entitlement was set or removed for a year that was already open.
 */
export type LeaveLedgerKind = 'ACCRUAL' | 'CARRYOVER' | 'ADJUSTMENT' | 'USAGE' | 'CANCELLATION' | 'ENTITLEMENT_CORRECTION';

/** GET /leave/employees/:id/ledger?year= - one leave ledger row, newest first. */
export interface LeaveLedgerEntryDto {
  id: string;
  createdAt: string;
  leaveTypeId: string;
  year: number;
  kind: LeaveLedgerKind;
  /** Signed minutes: positive credits, negative debits. */
  minutes: number;
  /** Why: the reason HR typed (adjustments, entitlement changes). null for automatic rows. */
  note: string | null;
  /** Automatic rows: what they cover. 'YYYY-MM' for a monthly accrual, 'YYYY' for a yearly grant or the year carried over from. */
  period: string | null;
  /** The leave request behind USAGE / CANCELLATION rows. */
  requestId: string | null;
  /** Who posted it; null for rows the system wrote. */
  actor: { username: string } | null;
}

export interface LeaveApprovalStepDto {
  level: number;
  decision: RequestStatus;
  comment: string | null;
  approver: { id: string; username: string; name: string | null; nameAr: string | null };
  createdAt: string;
}

export interface RequestEmployeeRef {
  id: string;
  employeeCode: string;
  fullName: string;
  fullNameAr: string | null;
  departmentId: string | null;
  departmentName: string | null;
  departmentNameAr: string | null;
}

export interface LeaveRequestDto {
  id: string;
  employee: RequestEmployeeRef;
  /** null when the type is confidential for this viewer (sensitive leave seen by a department manager). */
  leaveType: LeaveTypeDto | null;
  confidential: boolean;
  mode: LeaveMode;
  /** Local dates covered (inclusive). Half-day and hourly requests have startDate === endDate. */
  startDate: string;
  endDate: string;
  startAt: string;
  endAt: string;
  minutes: number;
  /** null when confidential. */
  reason: string | null;
  status: RequestStatus;
  currentLevel: number;
  /** null when confidential. */
  approvalLevels: number | null;
  rejectionReason: string | null;
  createdAt: string;
  decidedAt: string | null;
  cancelledAt: string | null;
  approvals: LeaveApprovalStepDto[];
  /** Supporting documents; empty when confidential for this viewer. */
  documents: LeaveDocumentDto[];
}

/** One employee's yearly entitlement per leave type that keeps a balance (GET /leave/entitlements). */
export interface LeaveEntitlementRowDto {
  employee: {
    id: string;
    employeeCode: string;
    fullName: string;
    fullNameAr: string | null;
    departmentId: string | null;
    departmentName: string | null;
    departmentNameAr: string | null;
    hireDate: string | null;
  };
  entitlements: {
    leaveTypeId: string;
    /** The type's default for everyone. */
    defaultMinutes: number;
    /** What applies to this employee in the requested year. */
    effectiveMinutes: number;
    /** The personal entitlement in force, if any. */
    custom: { id: string; fromYear: number; minutes: number; note: string | null } | null;
  }[];
}

/** Gives one or several employees a personal yearly entitlement for a leave type from `fromYear` on. */
export interface SetLeaveEntitlementInput {
  employeeIds: string[];
  leaveTypeId: string;
  fromYear: number;
  annualEntitlementMinutes: number;
  note?: string;
}

/** Supporting document of a leave request (download: GET /leave/documents/:id/content). */
export interface LeaveDocumentDto {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: string;
  uploadedById: string;
}

export const LEAVE_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;
export const LEAVE_DOCUMENT_MAX_COUNT = 5;
/** Images browsers can display, and PDF. Checked against the file's first bytes, not only its name. */
export const LEAVE_DOCUMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;

export interface CreateLeaveRequestInput {
  leaveTypeId: string;
  mode: LeaveMode;
  /** FULL_DAY: first day; HALF_DAY / HOURLY: the day. */
  startDate: string;
  /** FULL_DAY only (defaults to startDate). */
  endDate?: string;
  /** HALF_DAY only. */
  half?: HalfDay;
  /** HOURLY only, HH:MM local time. */
  startTime?: string;
  endTime?: string;
  reason: string;
}

/** POST /leave/requests/preview - what a request would cost before submitting it. */
export interface LeavePreviewDto {
  minutes: number;
  workdays: number;
  startAt: string;
  endAt: string;
  available: number | null;
  sufficient: boolean;
  overlaps: { id: string; startDate: string; endDate: string; status: RequestStatus }[];
}

// ───────────────────────────── Overtime ─────────────────────────────

export type OvertimeKind = 'REGULAR' | 'WEEKEND' | 'HOLIDAY';
export type OvertimeCompensation = 'PAY' | 'TIME_OFF';

export interface OvertimePolicyDto {
  id: string;
  name: string;
  /** Decimal strings, e.g. "1.25". Configured by HR - never statutory constants. */
  regularMultiplier: string;
  weekendMultiplier: string;
  holidayMultiplier: string;
  minimumMinutes: number;
  requiresPreApproval: boolean;
  allowRetroApproval: boolean;
  notes: string | null;
  isDefault: boolean;
}

export interface UpdateOvertimePolicyInput {
  regularMultiplier?: string;
  weekendMultiplier?: string;
  holidayMultiplier?: string;
  minimumMinutes?: number;
  requiresPreApproval?: boolean;
  allowRetroApproval?: boolean;
  notes?: string | null;
}

export interface OvertimeEstimateDto {
  /** Minutes the estimate is based on (approved, else requested). */
  baseMinutes: number;
  multiplier: string;
  /** baseMinutes × multiplier, rounded to whole minutes: paid-equivalent minutes or time off. */
  compensatedMinutes: number;
}

export interface OvertimeRequestDto {
  id: string;
  employee: RequestEmployeeRef;
  workDate: string;
  minutes: number;
  approvedMinutes: number | null;
  /** Extra minutes calc.ts reports for that date (null for days that have not ended). */
  recordedExtraMinutes: number | null;
  kind: OvertimeKind;
  compensation: OvertimeCompensation;
  isPreApproval: boolean;
  reason: string;
  status: RequestStatus;
  estimate: OvertimeEstimateDto;
  createdAt: string;
  decidedAt: string | null;
  approvals: LeaveApprovalStepDto[];
}

export interface CreateOvertimeRequestInput {
  workDate: string;
  minutes: number;
  compensation?: OvertimeCompensation;
  reason: string;
}

// ───────────────────────────── Corrections ─────────────────────────────

export type CorrectionKind = 'MISSING_CHECK_IN' | 'MISSING_CHECK_OUT' | 'WRONG_TIME';

export interface CorrectionRequestDto {
  id: string;
  employee: RequestEmployeeRef;
  kind: CorrectionKind;
  eventType: 'CHECK_IN' | 'CHECK_OUT';
  proposedTime: string;
  proposedEndTime: string | null;
  workSessionId: string | null;
  /** The session's current record (after approval: the corrected one). null for MISSING_CHECK_IN until approved. */
  session: { workDate: string; startedAt: string; endedAt: string | null; status: 'OPEN' | 'CLOSED' | 'MISSING_CHECKOUT' } | null;
  reason: string;
  status: RequestStatus;
  decisionComment: string | null;
  decidedBy: { id: string; username: string } | null;
  decidedAt: string | null;
  /** True for a correction HR applied directly (requester and approver are the same HR user). */
  direct: boolean;
  appliedEventId: string | null;
  createdAt: string;
}

export interface CreateCorrectionInput {
  kind: CorrectionKind;
  /** MISSING_CHECK_OUT / WRONG_TIME. */
  workSessionId?: string;
  /** WRONG_TIME only: which punch is wrong. */
  eventType?: 'CHECK_IN' | 'CHECK_OUT';
  /** ISO instant, or local wall time "YYYY-MM-DDTHH:mm" in the company timezone. */
  proposedTime: string;
  /** MISSING_CHECK_IN only: the check-out of the missing session. */
  proposedEndTime?: string;
  reason: string;
}

/** POST /corrections/direct - HR applies a correction for an employee at once (attendance.correct). */
export interface DirectCorrectionInput extends CreateCorrectionInput {
  employeeId: string;
}

/** GET /corrections/me/sessions - recent sessions an employee may ask to correct. */
export interface CorrectableSessionDto {
  id: string;
  workDate: string;
  startedAt: string;
  endedAt: string | null;
  status: 'OPEN' | 'CLOSED' | 'MISSING_CHECKOUT';
  pendingCorrection: boolean;
}

// ───────────────────────────── Approval Center ─────────────────────────────

export type ApprovalTab = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ApprovalItemDto {
  kind: RequestKind;
  id: string;
  status: RequestStatus;
  employee: RequestEmployeeRef;
  submittedAt: string;
  decidedAt: string | null;
  /** True when the viewer may approve or reject this item now. */
  canAct: boolean;
  /** Exactly one of these is set, matching `kind`. */
  leave: LeaveRequestDto | null;
  overtime: OvertimeRequestDto | null;
  correction: CorrectionRequestDto | null;
}

export interface ApprovalSummaryDto {
  pending: { leave: number; overtime: number; correction: number; total: number };
}

export interface DecisionInput {
  /** Required for rejections (the reason shown to the requester). */
  comment?: string;
}

export interface BulkApproveInput {
  items: { kind: RequestKind; id: string }[];
  comment?: string;
}

/** A day on which an employee worked beyond the requirement, for direct overtime approval. */
export interface OvertimeCandidateDto {
  employee: RequestEmployeeRef;
  workDate: string;
  kind: OvertimeKind;
  /** Minutes beyond the day's requirement (calc.ts). */
  extraMinutes: number;
  firstIn: string | null;
  lastOut: string | null;
  /** The employee's own request for the day, if any. */
  request: { id: string; status: 'PENDING' | 'APPROVED'; minutes: number; approvedMinutes: number | null } | null;
  /** False for the approver's own days and days already approved. */
  canApprove: boolean;
}

/** Approve overtime for chosen days without a request (minutes default to the recorded extra time). */
export interface DirectOvertimeInput {
  items: { employeeId: string; workDate: string; minutes?: number }[];
  compensation?: OvertimeCompensation;
  comment?: string;
}

export interface DirectOvertimeResultDto {
  approved: number;
  failed: number;
  results: { employeeId: string; workDate: string; ok: boolean; requestId: string | null; approvedMinutes: number | null; error: string | null }[];
}

export interface BulkApproveResultDto {
  approved: number;
  failed: number;
  results: { kind: RequestKind; id: string; ok: boolean; status: RequestStatus | null; error: string | null }[];
}

/** Notification `type` keys written by the request workflows; `data.kind` says which request type. */
export const REQUEST_NOTIFICATION_TYPES = {
  PENDING_APPROVAL: 'REQUEST_PENDING_APPROVAL',
  APPROVED: 'REQUEST_APPROVED',
  REJECTED: 'REQUEST_REJECTED',
  LEVEL_APPROVED: 'REQUEST_LEVEL_APPROVED',
} as const;
