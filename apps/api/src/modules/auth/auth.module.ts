import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { apiRateLimit, throttlingDisabled } from './auth.constants';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginAttemptLimiter } from './login-attempts';
import { AuthGuard } from './guards/auth.guard';
import { CsrfGuard } from './guards/csrf.guard';
import { PasswordChangeGuard } from './guards/password-change.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { HealthController } from './health.controller';
import { RolesController } from './roles.controller';
import { SessionService } from './session.service';

/**
 * Authentication + the app-wide guard chain. APP_GUARD providers run in registration order:
 * rate limit -> authenticate -> pending password change -> CSRF -> permissions.
 */
@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: () => apiRateLimit() }],
      skipIf: () => throttlingDisabled(),
    }),
  ],
  controllers: [AuthController, RolesController, HealthController],
  providers: [
    AuthService,
    SessionService,
    LoginAttemptLimiter,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PasswordChangeGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [SessionService],
})
export class AuthModule {}
