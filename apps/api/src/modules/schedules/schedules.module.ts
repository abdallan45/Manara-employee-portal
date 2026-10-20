import { Module } from '@nestjs/common';
import { ScheduleResolver } from './schedule-resolver';
import { SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';

@Module({ controllers: [SchedulesController], providers: [ScheduleResolver, SchedulesService], exports: [ScheduleResolver] })
export class SchedulesModule {}
