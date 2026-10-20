import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/** Read-only reports built on the same calc.ts figures as the dashboard. */
@Module({ imports: [AttendanceModule], controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
