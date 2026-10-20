import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PortalVisibilityInterceptor } from './portal-visibility.interceptor';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Global()
@Module({
  controllers: [SettingsController],
  providers: [
    SettingsService,
    // Refuses request creation for employee-portal pages HR turned off (runs after the auth guards).
    { provide: APP_INTERCEPTOR, useClass: PortalVisibilityInterceptor },
  ],
  exports: [SettingsService],
})
export class SettingsModule {}
