import type { Request } from 'express';
import type { AuthUser } from '../auth';

/** How the current request was authenticated (set by AuthGuard, read by CsrfGuard). */
export interface RequestAuthContext {
  sessionId: string;
  via: 'cookie' | 'bearer';
  csrfHash: string | null;
  /** The user must change their password before using anything but the allow-listed auth routes. */
  mustChangePassword: boolean;
}

export interface AppRequest extends Request {
  user?: AuthUser;
  authContext?: RequestAuthContext;
}

/** Client IP as Express resolved it (only honours X-Forwarded-For when TRUSTED_PROXIES allows it). */
export const clientIp = (req: Request): string => req.ip ?? req.socket?.remoteAddress ?? '';
