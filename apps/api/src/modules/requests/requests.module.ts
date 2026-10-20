import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SchedulesModule } from '../schedules/schedules.module';
import { ApprovalsService } from './approvals.service';
import { CorrectionsService } from './corrections.service';
import { LeaveDocumentsService } from './leave-documents.service';
import { LeaveEntitlementsService } from './leave-entitlements.service';
import { LeaveTypesService } from './leave-types.service';
import { LeaveService } from './leave.service';
import { OvertimeService } from './overtime.service';
import { ApproverDirectory } from './request-common';
import { ApprovalsController, CorrectionsController, LeaveController, OvertimeController } from './requests.controller';

/** Leave, overtime and attendance correction workflows plus the Approval Center. */
@Module({
  imports: [AttendanceModule, SchedulesModule, NotificationsModule],
  controllers: [LeaveController, OvertimeController, CorrectionsController, ApprovalsController],
  providers: [ApproverDirectory, LeaveService, LeaveTypesService, LeaveDocumentsService, LeaveEntitlementsService, OvertimeService, CorrectionsService, ApprovalsService],
  exports: [LeaveService, OvertimeService, CorrectionsService, ApprovalsService],
})
export class RequestsModule {}
