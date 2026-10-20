import { Module } from '@nestjs/common';
import { GeofenceService } from './geofence.service';
import { OfficesController } from './offices.controller';

@Module({ controllers: [OfficesController], providers: [GeofenceService], exports: [GeofenceService] })
export class OfficesModule {}
