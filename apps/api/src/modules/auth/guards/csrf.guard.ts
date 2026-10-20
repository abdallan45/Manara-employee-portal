import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AppError } from '../../../common/app-error';
import type { AppRequest } from '../../../common/http/request';
import { CSRF_HEADER } from '../auth.constants';
import { safeEqualHex, sha256Hex } from '../password';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit protection for cookie-authenticated requests: state-changing calls must echo the
 * per-session CSRF token in X-CSRF-Token. Bearer clients cannot be driven cross-site, so they are exempt.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<AppRequest>();
    const auth = req.authContext;
    if (!auth || auth.via !== 'cookie' || SAFE_METHODS.has(req.method)) return true;

    const presented = req.get(CSRF_HEADER);
    if (!presented || presented.length > 256 || !auth.csrfHash || !safeEqualHex(sha256Hex(presented), auth.csrfHash)) {
      throw AppError.forbidden('CSRF_FAILED', 'Missing or invalid CSRF token');
    }
    return true;
  }
}
