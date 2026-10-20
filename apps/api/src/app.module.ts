import { Module } from '@nestjs/common';
import { PrismaModule } from './common/prisma.service';
import { AuditModule } from './modules/audit/audit.module';
import { SettingsModule } from './modules/settings/settings.module';
import { AuthModule } from './modules/auth/auth.module';
import { EmployeesModule } from './modules/employees/employees.module';
import { DepartmentsModule } from './modules/departments/departments.module';
import { OfficesModule } from './modules/offices/offices.module';
import { SchedulesModule } from './modules/schedules/schedules.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ReportsModule } from './modules/reports/reports.module';
import { RequestsModule } from './modules/requests/requests.module';
import { MascotModule } from './modules/mascot/mascot.module';

@Module({
  imports: [
    PrismaModule, AuditModule, SettingsModule,
    AuthModule, EmployeesModule, DepartmentsModule,
    OfficesModule, SchedulesModule, AttendanceModule, DashboardModule, NotificationsModule,
    // requests & approvals
    RequestsModule, ReportsModule,
    // Nouria the mascot
    MascotModule,
  ],
})
export class AppModule {}
