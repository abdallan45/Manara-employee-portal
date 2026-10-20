import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { DemoAccountDto, LoginResponse, SessionUser } from '@workforce/shared';
import type { CookieOptions, Request, Response } from 'express';
import { AppError } from '../../common/app-error';
import { AuthUser, CurrentUser, Public } from '../../common/auth';
import { clientIp } from '../../common/http/request';
import { CSRF_COOKIE, demoAllowsRemote, demoIncludesAdmins, isDemoMode, isLoopbackPeer, loginRateLimit, SESSION_COOKIE } from './auth.constants';
import { AuthService, LoginResult, RequestMeta } from './auth.service';
import { ChangePasswordDto, DemoLoginDto, LocaleDto, LoginDto } from './dto/auth.dto';
import { AllowPendingPasswordChange } from './guards/password-change.guard';

const LOGIN_THROTTLE = { default: { limit: () => loginRateLimit(), ttl: 60_000 } };

const meta = (req: Request): RequestMeta => ({ ip: clientIp(req), userAgent: req.get('user-agent') ?? undefined });

function cookieBase(req: Request): CookieOptions {
  return { sameSite: 'strict', secure: req.secure, path: '/' };
}

/**
 * Demo endpoints exist only with DEMO_MODE=true outside production, and only for a loopback TCP peer unless
 * DEMO_ALLOW_REMOTE=true. Anything else gets the same 404 as when demo mode is off.
 */
function assertDemoAllowed(req: Request): void {
  if (!isDemoMode()) throw AppError.notFound();
  if (!demoAllowsRemote() && !isLoopbackPeer(req)) throw AppError.notFound();
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle(LOGIN_THROTTLE)
  @ApiOperation({ summary: 'Sign in. WEB sets the session + CSRF cookies; MOBILE returns a bearer token.' })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<LoginResponse> {
    const result = await this.auth.login(dto.username, dto.password, dto.client ?? 'WEB', meta(req));
    return this.respond(result, req, res);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AllowPendingPasswordChange()
  @ApiOperation({ summary: 'Revoke the current session and clear cookies' })
  async logout(@CurrentUser() user: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(user.sessionId, user.userId, user.ip);
    this.clearCookies(req, res);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AllowPendingPasswordChange()
  @ApiOperation({ summary: "Revoke ALL of the signed-in user's sessions (every device, including this one) and clear cookies" })
  async logoutAll(@CurrentUser() user: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logoutAll(user.sessionId, user.userId, user.ip);
    this.clearCookies(req, res);
  }

  @Get('me')
  @AllowPendingPasswordChange()
  @ApiOperation({ summary: 'The signed-in user with roles and effective permissions' })
  me(@CurrentUser() user: AuthUser): Promise<SessionUser> {
    return this.auth.me(user.userId);
  }

  @Post('me/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(LOGIN_THROTTLE)
  @AllowPendingPasswordChange()
  @ApiOperation({ summary: 'Change your own password; signs out your other sessions and clears the must-change flag' })
  async changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto, @Req() req: Request): Promise<void> {
    await this.auth.changePassword(user.userId, user.sessionId, dto.currentPassword, dto.newPassword, meta(req));
  }

  @Patch('me/locale')
  @ApiOperation({ summary: 'Set the preferred UI language' })
  setLocale(@CurrentUser() user: AuthUser, @Body() dto: LocaleDto): Promise<SessionUser> {
    return this.auth.setLocale(user.userId, dto.locale, user.ip);
  }

  @Public()
  @Get('demo/accounts')
  @ApiOperation({ summary: 'Demo accounts for one-click login (404 unless DEMO_MODE=true outside production, from loopback)' })
  demoAccounts(@Req() req: Request): Promise<DemoAccountDto[]> {
    assertDemoAllowed(req);
    return this.auth.demoAccounts(demoIncludesAdmins());
  }

  @Public()
  @Post('demo/login')
  @HttpCode(HttpStatus.OK)
  @Throttle(LOGIN_THROTTLE)
  @ApiOperation({ summary: 'One-click demo login (404 unless DEMO_MODE=true outside production, from loopback)' })
  async demoLogin(@Body() dto: DemoLoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<LoginResponse> {
    assertDemoAllowed(req);
    const result = await this.auth.demoLogin(dto.username, demoIncludesAdmins(), meta(req));
    return this.respond(result, req, res);
  }

  private clearCookies(req: Request, res: Response): void {
    res.clearCookie(SESSION_COOKIE, { ...cookieBase(req), httpOnly: true });
    res.clearCookie(CSRF_COOKIE, cookieBase(req));
  }

  /**
   * WEB cookies are browser-session cookies (no Expires/Max-Age): closing the browser drops them. The session
   * still expires server-side after auth.sessionHours, or after auth.idleMinutes without activity.
   */
  private respond({ session, user, client }: LoginResult, req: Request, res: Response): LoginResponse {
    const expiresAt = session.expiresAt.toISOString();
    if (client === 'MOBILE') return { user, accessToken: session.token, expiresAt };
    res.cookie(SESSION_COOKIE, session.token, { ...cookieBase(req), httpOnly: true });
    res.cookie(CSRF_COOKIE, session.csrfToken!, { ...cookieBase(req), httpOnly: false });
    return { user, csrfToken: session.csrfToken!, expiresAt };
  }
}
