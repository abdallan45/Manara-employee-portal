import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({ imports: [AttendanceModule], controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}
