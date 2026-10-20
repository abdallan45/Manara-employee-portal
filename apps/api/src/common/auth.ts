import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission } from '@workforce/shared';

/** The authenticated principal, attached to the request by the global AuthGuard. */
export interface AuthUser {
  userId: string;
  sessionId: string;
  username: string;
  employeeId: string | null;
  roles: string[];
  permissions: Set<string>;
  /** Department ids where the user holds a department-scoped role (team scope). */
  managedDepartmentIds: string[];
  /** Client IP as resolved by Express (honours TRUSTED_PROXIES only). */
  ip: string;
}

export const IS_PUBLIC = 'isPublic';
/** Skip authentication for this route (login, health, demo accounts). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const REQUIRED_PERMISSIONS = 'requiredPermissions';
/** Require ALL listed permissions. Use RequireAnyPermission for "any of". */
export const RequirePermissions = (...permissions: Permission[]) => SetMetadata(REQUIRED_PERMISSIONS, { mode: 'all', permissions });
export const RequireAnyPermission = (...permissions: Permission[]) => SetMetadata(REQUIRED_PERMISSIONS, { mode: 'any', permissions });

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);
