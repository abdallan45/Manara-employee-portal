import { Module } from '@nestjs/common';
import { OfficesModule } from '../offices/offices.module';
import { SchedulesModule } from '../schedules/schedules.module';
import { AttendanceMetricsService } from './attendance-metrics.service';
import { AttendanceController, BreakTypesController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { BreakTypesService } from './break-types.service';

@Module({
  imports: [OfficesModule, SchedulesModule],
  controllers: [AttendanceController, BreakTypesController],
  providers: [AttendanceService, AttendanceMetricsService, BreakTypesService],
  exports: [AttendanceService, AttendanceMetricsService],
})
export class AttendanceModule {}
