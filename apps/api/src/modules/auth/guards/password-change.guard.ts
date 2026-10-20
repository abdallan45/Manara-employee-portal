import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../../common/app-error';
import type { AppRequest } from '../../../common/http/request';

export const ALLOW_PENDING_PASSWORD_CHANGE = 'allowPendingPasswordChange';
/** Marks a route usable while the signed-in user still has to change their password. */
export const AllowPendingPasswordChange = () => SetMetadata(ALLOW_PENDING_PASSWORD_CHANGE, true);

/**
 * Runs after AuthGuard. While users.must_change_password is set (administrator-assigned or seeded password),
 * only routes marked @AllowPendingPasswordChange (GET /auth/me, POST /auth/me/password, logout, logout-all)
 * are served; everything else answers 403 PASSWORD_CHANGE_REQUIRED.
 */
@Injectable()
export class PasswordChangeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<AppRequest>();
    if (!req.authContext?.mustChangePassword) return true;
    const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD_CHANGE, [context.getHandler(), context.getClass()]);
    if (allowed) return true;
    throw AppError.forbidden('PASSWORD_CHANGE_REQUIRED', 'You must change your password before continuing (POST /api/v1/auth/me/password)');
  }
}
