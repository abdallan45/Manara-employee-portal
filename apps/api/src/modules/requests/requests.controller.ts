import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  LEAVE_DOCUMENT_MAX_BYTES, LEAVE_DOCUMENT_MAX_COUNT, PERMISSIONS,
  type ApprovalItemDto, type DirectOvertimeResultDto, type LeaveDocumentDto, type LeaveEntitlementRowDto, type OvertimeCandidateDto, type ApprovalSummaryDto, type BulkApproveResultDto, type CorrectableSessionDto, type CorrectionRequestDto,
  type LeaveBalanceDto, type LeaveLedgerEntryDto, type LeavePreviewDto, type LeaveRequestDto, type LeaveTypeDto, type OvertimePolicyDto, type OvertimeRequestDto,
  type Paginated, type RequestKind,
} from '@workforce/shared';
import { AppError } from '../../common/app-error';
import { CurrentUser, RequireAnyPermission, RequirePermissions, type AuthUser } from '../../common/auth';
import { localDate } from '../../common/time';
import { ApprovalsService } from './approvals.service';
import { CorrectionsService } from './corrections.service';
import { LeaveDocumentsService, type UploadedDocument } from './leave-documents.service';
import { LeaveEntitlementsService } from './leave-entitlements.service';
import { LeaveTypesService } from './leave-types.service';
import { LeaveService } from './leave.service';
import { OvertimeService } from './overtime.service';
import { requireEmployee } from './request-common';
import {
  ApprovalListQueryDto, BulkApproveDto, CorrectionBodyDto, CreateLeaveTypeDto, DirectCorrectionBodyDto, DecisionDto, LeaveAdjustmentDto, LeaveEntitlementQueryDto, LeaveListQueryDto,
  LeaveRequestBodyDto, LeaveTypesQueryDto, OvertimeCandidatesQueryDto, DirectOvertimeDto, OvertimeRequestBodyDto, SetLeaveEntitlementDto, StatusQueryDto, UpdateLeaveTypeDto, UpdateOvertimePolicyDto, YearQueryDto,
} from './requests.dto';

const P = PERMISSIONS;
const thisYear = () => Number(localDate(new Date()).slice(0, 4));

@ApiTags('Leave')
@Controller('leave')
export class LeaveController {
  constructor(
    private readonly leave: LeaveService,
    private readonly leaveTypes: LeaveTypesService,
    private readonly documents: LeaveDocumentsService,
    private readonly entitlements: LeaveEntitlementsService,
  ) {}

  @Get('types')
  @RequireAnyPermission(P.LEAVE_SELF, P.LEAVE_APPROVE, P.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Leave types (active only unless includeInactive=true and the caller has settings.manage)' })
  types(@CurrentUser() user: AuthUser, @Query() q: LeaveTypesQueryDto): Promise<LeaveTypeDto[]> {
    return this.leaveTypes.list(q.includeInactive === 'true' && user.permissions.has(P.SETTINGS_MANAGE));
  }

  @Post('types')
  @RequirePermissions(P.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Create a leave type (company configuration; audited)' })
  createType(@CurrentUser() user: AuthUser, @Body() body: CreateLeaveTypeDto): Promise<LeaveTypeDto> {
    return this.leaveTypes.create(user, body);
  }

  @Patch('types/:id')
  @RequirePermissions(P.SETTINGS_MANAGE)
  @ApiOperation({
    summary: 'Update, deactivate (isActive=false) or reactivate a leave type; the code is fixed. Ledger rows already posted are not recalculated',
  })
  updateType(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateLeaveTypeDto): Promise<LeaveTypeDto> {
    return this.leaveTypes.update(user, id, body);
  }

  @Get('me/balances')
  @RequirePermissions(P.LEAVE_SELF)
  @ApiOperation({ summary: 'My balances for a year, computed from the leave ledger (accrual and carryover are posted on first access)' })
  myBalances(@CurrentUser() user: AuthUser, @Query() q: YearQueryDto): Promise<LeaveBalanceDto[]> {
    return this.leave.balances(requireEmployee(user), q.year ?? thisYear(), { userId: user.userId, employeeId: user.employeeId, companyWide: false });
  }

  @Get('me/requests')
  @RequirePermissions(P.LEAVE_SELF)
  @ApiOperation({ summary: 'My leave requests (newest first)' })
  myRequests(@CurrentUser() user: AuthUser, @Query() q: LeaveListQueryDto): Promise<LeaveRequestDto[]> {
    return this.leave.mine(user, q);
  }

  @Post('requests/preview')
  @HttpCode(200)
  @RequirePermissions(P.LEAVE_SELF)
  @ApiOperation({ summary: 'Cost of a request (minutes, working days), remaining balance and overlaps, without saving' })
  preview(@CurrentUser() user: AuthUser, @Body() body: LeaveRequestBodyDto): Promise<LeavePreviewDto> {
    return this.leave.preview(user, body);
  }

  @Post('requests')
  @RequirePermissions(P.LEAVE_SELF)
  @ApiOperation({ summary: 'Request leave (full day, half day or hourly); checks overlaps and balance' })
  create(@CurrentUser() user: AuthUser, @Body() body: LeaveRequestBodyDto): Promise<LeaveRequestDto> {
    return this.leave.create(user, body);
  }

  @Get('requests/:id')
  @RequireAnyPermission(P.LEAVE_SELF, P.LEAVE_APPROVE)
  @ApiOperation({ summary: 'One leave request (own, or in my approval scope; sensitive types are masked for managers)' })
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<LeaveRequestDto> {
    return this.leave.getFor(user, id);
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  @RequireAnyPermission(P.LEAVE_SELF, P.LEAVE_APPROVE)
  @ApiOperation({ summary: 'Cancel a pending request, or approved leave that has not started (HR: any time); approved days are credited back' })
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<LeaveRequestDto> {
    return this.leave.cancel(user, id);
  }

  @Post('requests/:id/documents')
  @RequireAnyPermission(P.LEAVE_SELF, P.LEAVE_APPROVE)
  // Twice the limit so slightly larger files get the clear ATTACHMENT_TOO_LARGE answer from the service.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: LEAVE_DOCUMENT_MAX_BYTES * 2, files: 1, fields: 0 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({
    summary: `Attach a supporting document (JPEG, PNG, WebP or PDF, max ${LEAVE_DOCUMENT_MAX_BYTES / 1024 / 1024} MB, ${LEAVE_DOCUMENT_MAX_COUNT} per request): the requester while pending or approved, HR any time`,
  })
  addDocument(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: UploadedDocument | undefined): Promise<LeaveDocumentDto> {
    return this.documents.add(user, id, file);
  }

  @Get('documents/:id/content')
  @RequireAnyPermission(P.LEAVE_SELF, P.LEAVE_APPROVE)
  @ApiOperation({ summary: 'Open a supporting document (same visibility as the request; sensitive types are hidden from managers)' })
  async documentContent(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const doc = await this.documents.content(user, id);
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Length', String(doc.data.length));
    res.setHeader('Content-Disposition', `inline; filename="${doc.fileName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(doc.data);
  }

  @Delete('documents/:id')
  @HttpCode(204)
  @RequireAnyPermission(P.LEAVE_SELF, P.LEAVE_APPROVE)
  @ApiOperation({ summary: 'Remove a document: the uploader while the request is pending, or HR' })
  removeDocument(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.documents.remove(user, id);
  }

  @Get('employees/:id/balances')
  @RequirePermissions(P.LEAVE_APPROVE)
  @ApiOperation({ summary: 'Balances of an employee in my approval scope' })
  async employeeBalances(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: YearQueryDto): Promise<LeaveBalanceDto[]> {
    const viewer = await this.leave.assertCanView(user, id);
    return this.leave.balances(id, q.year ?? thisYear(), viewer);
  }

  @Get('employees/:id/ledger')
  @RequirePermissions(P.LEAVE_APPROVE)
  @ApiOperation({
    summary: 'Leave ledger of an employee in my approval scope for a year, newest first: accruals, carryover, adjustments, entitlement corrections, leave taken',
  })
  async employeeLedger(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: YearQueryDto): Promise<LeaveLedgerEntryDto[]> {
    const viewer = await this.leave.assertCanView(user, id);
    return this.leave.ledger(id, q.year ?? thisYear(), viewer);
  }

  @Get('entitlements')
  @RequirePermissions(P.LEAVE_APPROVE)
  @ApiOperation({ summary: 'Yearly entitlement per employee and leave type for a year: the default or a personal one (HR)' })
  listEntitlements(@CurrentUser() user: AuthUser, @Query() q: LeaveEntitlementQueryDto): Promise<LeaveEntitlementRowDto[]> {
    return this.entitlements.list(user, { year: q.year ?? thisYear(), departmentId: q.departmentId, employeeId: q.employeeId });
  }

  @Post('entitlements')
  @HttpCode(200)
  @RequirePermissions(P.LEAVE_APPROVE)
  @ApiOperation({
    summary: 'Give one or several employees a personal yearly entitlement from a year on (HR); open years are corrected in the ledger at once',
  })
  setEntitlement(@CurrentUser() user: AuthUser, @Body() body: SetLeaveEntitlementDto): Promise<{ updated: number; ledgerCorrections: number }> {
    return this.entitlements.set(user, body);
  }

  @Delete('entitlements/:id')
  @HttpCode(204)
  @RequirePermissions(P.LEAVE_APPROVE)
  @ApiOperation({ summary: 'Remove a personal entitlement: back to the default (or an earlier personal one) from that year on (HR)' })
  removeEntitlement(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.entitlements.remove(user, id);
  }

  @Post('adjustments')
  @RequirePermissions(P.LEAVE_APPROVE)
  @ApiOperation({ summary: 'HR ledger adjustment (opening balance, correction)' })
  adjust(@CurrentUser() user: AuthUser, @Body() body: LeaveAdjustmentDto): Promise<LeaveBalanceDto> {
    return this.leave.adjust(user, body);
  }
}

@ApiTags('Overtime')
@Controller('overtime')
export class OvertimeController {
  constructor(private readonly overtime: OvertimeService) {}

  @Get('policy')
  @RequireAnyPermission(P.OVERTIME_SELF, P.OVERTIME_APPROVE, P.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'The overtime policy in force (multipliers are company configuration, not statutory rates)' })
  policy(): Promise<OvertimePolicyDto> {
    return this.overtime.policy();
  }

  @Patch('policies/:id')
  @RequirePermissions(P.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Update an overtime policy; existing requests keep the multiplier they were made with' })
  updatePolicy(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateOvertimePolicyDto): Promise<OvertimePolicyDto> {
    return this.overtime.updatePolicy(user, id, body);
  }

  @Get('candidates')
  @RequirePermissions(P.OVERTIME_APPROVE)
  @ApiOperation({ summary: 'Days on which employees in my scope worked beyond their requirement, with what is approved or pending' })
  candidates(@CurrentUser() user: AuthUser, @Query() q: OvertimeCandidatesQueryDto): Promise<OvertimeCandidateDto[]> {
    return this.overtime.candidates(user, q);
  }

  @Post('direct')
  @HttpCode(200)
  @RequirePermissions(P.OVERTIME_APPROVE)
  @ApiOperation({ summary: 'Approve overtime for chosen days without a request from the employee (each day saved and reported on its own)' })
  approveDirect(@CurrentUser() user: AuthUser, @Body() body: DirectOvertimeDto): Promise<DirectOvertimeResultDto> {
    return this.overtime.approveDirect(user, body);
  }

  @Get('me/requests')
  @RequirePermissions(P.OVERTIME_SELF)
  @ApiOperation({ summary: 'My overtime requests with compensation estimates' })
  mine(@CurrentUser() user: AuthUser, @Query() q: StatusQueryDto): Promise<OvertimeRequestDto[]> {
    return this.overtime.mine(user, q);
  }

  @Post('requests')
  @RequirePermissions(P.OVERTIME_SELF)
  @ApiOperation({ summary: 'Request overtime: pre-approval for today or later, retrospective (capped at recorded extra minutes) for past days' })
  create(@CurrentUser() user: AuthUser, @Body() body: OvertimeRequestBodyDto): Promise<OvertimeRequestDto> {
    return this.overtime.create(user, body);
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  @RequirePermissions(P.OVERTIME_SELF)
  @ApiOperation({ summary: 'Cancel my pending overtime request' })
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<OvertimeRequestDto> {
    return this.overtime.cancel(user, id);
  }
}

@ApiTags('Attendance corrections')
@Controller('corrections')
export class CorrectionsController {
  constructor(private readonly corrections: CorrectionsService) {}

  @Get('me/sessions')
  @RequirePermissions(P.ATTENDANCE_SELF)
  @ApiOperation({ summary: 'My work sessions of the last 31 days that a correction can refer to' })
  sessions(@CurrentUser() user: AuthUser): Promise<CorrectableSessionDto[]> {
    return this.corrections.sessions(user);
  }

  @Get('me/requests')
  @RequirePermissions(P.ATTENDANCE_SELF)
  @ApiOperation({ summary: 'My correction requests' })
  mine(@CurrentUser() user: AuthUser, @Query() q: StatusQueryDto): Promise<CorrectionRequestDto[]> {
    return this.corrections.mine(user, q);
  }

  @Post('requests')
  @RequirePermissions(P.ATTENDANCE_SELF)
  @ApiOperation({ summary: 'Request a correction (missing check-in / check-out, wrong time)' })
  create(@CurrentUser() user: AuthUser, @Body() body: CorrectionBodyDto): Promise<CorrectionRequestDto> {
    return this.corrections.create(user, body);
  }

  @Get('employees/:id/sessions')
  @RequirePermissions(P.ATTENDANCE_CORRECT, P.ATTENDANCE_READ_ALL)
  @ApiOperation({ summary: "HR: an employee's work sessions of the last 31 days that can be corrected" })
  employeeSessions(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<CorrectableSessionDto[]> {
    return this.corrections.employeeSessions(user, id);
  }

  @Get('employees/:id/requests')
  @RequirePermissions(P.ATTENDANCE_CORRECT, P.ATTENDANCE_READ_ALL)
  @ApiOperation({ summary: "HR: an employee's corrections (requests and direct corrections), newest first" })
  employeeHistory(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<CorrectionRequestDto[]> {
    return this.corrections.employeeHistory(user, id);
  }

  @Post('direct')
  @RequirePermissions(P.ATTENDANCE_CORRECT, P.ATTENDANCE_READ_ALL)
  @ApiOperation({
    summary: "HR: correct an employee's attendance at once (appends ADMIN_CORRECTION events; recorded as an approved correction; audited; the employee is notified)",
  })
  direct(@CurrentUser() user: AuthUser, @Body() body: DirectCorrectionBodyDto): Promise<CorrectionRequestDto> {
    const { employeeId, ...input } = body;
    return this.corrections.correctDirect(user, employeeId, input);
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  @RequirePermissions(P.ATTENDANCE_SELF)
  @ApiOperation({ summary: 'Cancel my pending correction request' })
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<CorrectionRequestDto> {
    return this.corrections.cancel(user, id);
  }
}

const KIND_PARAM: Record<string, RequestKind> = { leave: 'LEAVE', overtime: 'OVERTIME', correction: 'CORRECTION' };
const kindOf = (value: string): RequestKind => {
  const kind = KIND_PARAM[value];
  if (!kind) throw AppError.notFound('Unknown request type');
  return kind;
};

@ApiTags('Approval Center')
@Controller('approvals')
@RequireAnyPermission(P.LEAVE_APPROVE, P.OVERTIME_APPROVE, P.CORRECTIONS_APPROVE)
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @ApiOperation({ summary: 'Requests in my approval scope: PENDING (actionable first), APPROVED or REJECTED' })
  list(@CurrentUser() user: AuthUser, @Query() q: ApprovalListQueryDto): Promise<Paginated<ApprovalItemDto>> {
    return this.approvals.list(user, q);
  }

  @Get('summary')
  @ApiOperation({ summary: 'Counts of requests I can decide now' })
  summary(@CurrentUser() user: AuthUser): Promise<ApprovalSummaryDto> {
    return this.approvals.summary(user);
  }

  @Post('bulk-approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve several requests; each is checked and saved on its own' })
  bulk(@CurrentUser() user: AuthUser, @Body() body: BulkApproveDto): Promise<BulkApproveResultDto> {
    return this.approvals.bulkApprove(user, body);
  }

  @Post(':kind/:id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve at the current level (kind: leave | overtime | correction)' })
  approve(@CurrentUser() user: AuthUser, @Param('kind') kind: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: DecisionDto): Promise<ApprovalItemDto> {
    return this.approvals.decide(user, kindOf(kind), id, 'APPROVED', body.comment);
  }

  @Post(':kind/:id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject with a reason (kind: leave | overtime | correction)' })
  reject(@CurrentUser() user: AuthUser, @Param('kind') kind: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: DecisionDto): Promise<ApprovalItemDto> {
    return this.approvals.decide(user, kindOf(kind), id, 'REJECTED', body.comment);
  }
}
