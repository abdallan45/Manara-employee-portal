import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AttendanceModule } from '../attendance/attendance.module';
import { AttendanceAlertsJob } from './attendance-alerts.job';
import { NotificationService } from './notification.service';
import { NotificationsController } from './notifications.controller';

@Module({
  imports: [ScheduleModule.forRoot(), AttendanceModule],
  controllers: [NotificationsController],
  providers: [NotificationService, AttendanceAlertsJob],
  exports: [NotificationService, AttendanceAlertsJob],
})
export class NotificationsModule {}
