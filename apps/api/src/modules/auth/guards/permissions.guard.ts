import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../../common/app-error';
import { REQUIRED_PERMISSIONS } from '../../../common/auth';
import type { AppRequest } from '../../../common/http/request';

interface PermissionRequirement { mode: 'all' | 'any'; permissions: string[] }

/** Enforces @RequirePermissions (all) / @RequireAnyPermission (any); handler metadata overrides class metadata. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<AppRequest>();
    const requirement = this.reflector.getAllAndOverride<PermissionRequirement | undefined>(REQUIRED_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requirement || requirement.permissions.length === 0) return true;
    const user = req.user;
    if (!user) throw AppError.unauthorized();
    const has = (p: string) => user.permissions.has(p);
    const ok = requirement.mode === 'any' ? requirement.permissions.some(has) : requirement.permissions.every(has);
    if (!ok) throw AppError.forbidden();
    return true;
  }
}
