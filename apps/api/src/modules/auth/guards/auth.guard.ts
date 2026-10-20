import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../../common/app-error';
import { IS_PUBLIC } from '../../../common/auth';
import { AppRequest, clientIp } from '../../../common/http/request';
import { SESSION_COOKIE } from '../auth.constants';
import { SessionService } from '../session.service';

/** Authenticates every non-@Public route from the session cookie or an Authorization: Bearer token. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AppRequest>();
    const header = req.get('authorization');
    let token: string | undefined;
    let via: 'cookie' | 'bearer' = 'cookie';
    if (header) {
      const m = /^Bearer\s+(\S+)$/i.exec(header);
      if (!m) throw AppError.unauthorized();
      token = m[1];
      via = 'bearer';
    } else {
      const cookies = req.cookies as Record<string, string> | undefined;
      token = cookies?.[SESSION_COOKIE];
    }
    if (!token) throw AppError.unauthorized();

    const resolved = await this.sessions.resolve(token, clientIp(req));
    if (!resolved) throw AppError.unauthorized('UNAUTHENTICATED', 'Session expired or invalid');
    req.user = resolved.user;
    req.authContext = { sessionId: resolved.user.sessionId, via, csrfHash: resolved.csrfHash, mustChangePassword: resolved.mustChangePassword };
    return true;
  }
}
