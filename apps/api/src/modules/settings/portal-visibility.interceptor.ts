import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { PERMISSIONS, PORTAL_DISABLED_REASON, isPortalVisible, type PortalKey } from '@workforce/shared';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../common/auth';
import { approverFor } from '../requests/approval-routing';
import { SettingsService } from './settings.service';

/**
 * Request-creation routes that belong to an employee-portal page or section. Keyed by
 * "<METHOD> <route path without the api/v1 prefix>"; all keys must be visible.
 */
const PORTAL_ROUTES: ReadonlyMap<string, readonly PortalKey[]> = new Map<string, readonly PortalKey[]>([
  ['POST /leave/requests', ['leave', 'leave.requests']],
  ['POST /leave/requests/preview', ['leave', 'leave.requests']],
  ['POST /leave/requests/:id/documents', ['leave', 'leave.documents']],
  ['POST /overtime/requests', ['overtime', 'overtime.requests']],
  ['POST /corrections/requests', ['corrections']],
]);

/**
 * Routes HR also uses from the administration pages (which follow roles, not this setting):
 * company-wide leave approvers pass even when the employee section is hidden.
 */
const HR_EXEMPT_ROUTES: ReadonlySet<string> = new Set(['POST /leave/requests/:id/documents']);
const isHr = (user: AuthUser | undefined) => !!user && approverFor(user, PERMISSIONS.LEAVE_APPROVE)?.companyWide === true;

const PREFIX = /^\/?api\/v1(?=\/|$)/;

/** "/api/v1/leave/requests/" -> "/leave/requests". */
export function portalRouteKey(method: string, routePath: string): string {
  const path = `/${routePath.replace(PREFIX, '').replace(/^\/+|\/+$/g, '')}`;
  return `${method.toUpperCase()} ${path}`;
}

/**
 * Refuses to create requests for employee-portal pages or sections that HR turned off
 * (system setting 'portal.visibility'). Runs after the auth guards; every other route passes untouched.
 */
@Injectable()
export class PortalVisibilityInterceptor implements NestInterceptor {
  constructor(private readonly settings: SettingsService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const routePath: unknown = (req.route as { path?: unknown } | undefined)?.path;
    if (typeof routePath !== 'string') return next.handle();
    const routeKey = portalRouteKey(req.method, routePath);
    const keys = PORTAL_ROUTES.get(routeKey);
    if (!keys) return next.handle();
    if (HR_EXEMPT_ROUTES.has(routeKey) && isHr((req as Request & { user?: AuthUser }).user)) return next.handle();

    const config = await this.settings.portalVisibility();
    const hidden = keys.find((key) => !isPortalVisible(config, key));
    if (hidden) {
      throw AppError.forbidden('FORBIDDEN', 'This part of the employee portal is turned off by your organization', {
        reason: PORTAL_DISABLED_REASON,
        key: hidden,
      });
    }
    return next.handle();
  }
}
