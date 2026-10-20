import { HttpStatus, Injectable } from '@nestjs/common';
import { SYSTEM_ROLES, type DemoAccountDto, type SessionUser } from '@workforce/shared';
import { AppError } from '../../common/app-error';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { LoginAttemptLimiter } from './login-attempts';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password';
import { IssuedSession, isPrincipalActive, Principal, PRINCIPAL_INCLUDE, SessionClient, SessionService, toSessionUser } from './session.service';

export interface RequestMeta { ip: string; userAgent?: string }

export interface LoginResult { session: IssuedSession; user: SessionUser; client: SessionClient }

export type DemoAccount = DemoAccountDto;

/**
 * The per-user database lock (any source IP) trips after this many times auth.maxFailedLogins failures.
 * It is a backstop against distributed guessing; the normal lock is per (username, IP) in LoginAttemptLimiter.
 */
export const USER_LOCK_FACTOR = 4;

const ADMIN_ROLES: string[] = [SYSTEM_ROLES.SUPER_ADMIN, SYSTEM_ROLES.HR_ADMIN];

const invalidCredentials = () => AppError.unauthorized('INVALID_CREDENTIALS', 'Invalid username or password');
const accountLocked = (until: Date) =>
  new AppError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', HttpStatus.LOCKED, { lockedUntil: until.toISOString() });

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly attempts: LoginAttemptLimiter,
  ) {}

  /**
   * Password sign-in. Order matters:
   *  1. The password is always verified first (against a dummy hash for unknown or deleted users), so timing
   *     and answers do not reveal whether a username exists.
   *  2. A wrong password is always 401 INVALID_CREDENTIALS - also while locked - so only someone who knows the
   *     password can learn that the account is locked.
   *  3. A correct password while the (username, IP) pair or the user is locked is 423 ACCOUNT_LOCKED.
   */
  async login(usernameRaw: string, password: string, client: SessionClient, meta: RequestMeta): Promise<LoginResult> {
    const username = usernameRaw.trim().toLowerCase();
    const found = await this.prisma.user.findUnique({ where: { username }, include: PRINCIPAL_INCLUDE });
    const user = found && !found.deletedAt ? found : null;

    const ok = await verifyPassword(user ? user.passwordHash : await dummyPasswordHash(), password);
    if (!ok) {
      await this.registerFailure(username, user, meta);
      throw invalidCredentials();
    }
    // From here on the caller knows the password.
    if (!user || !isPrincipalActive(user)) {
      await this.auditFailure(username, user?.id ?? null, meta, { reason: 'INACTIVE' });
      throw invalidCredentials();
    }

    const now = Date.now();
    const pairLock = this.attempts.lockedUntil(username, meta.ip, now);
    const userLock = user.lockedUntil && user.lockedUntil.getTime() > now ? user.lockedUntil : null;
    if (pairLock || userLock) {
      const until = pairLock && userLock ? (pairLock > userLock ? pairLock : userLock) : (pairLock ?? userLock)!;
      await this.auditFailure(username, user.id, meta, {
        reason: 'LOCKED', lockScope: userLock ? 'USER' : 'USERNAME_IP', lockedUntil: until.toISOString(),
      });
      throw accountLocked(until);
    }

    this.attempts.clear(username, meta.ip);
    return this.startSession(user, client, meta, 'LOGIN');
  }

  async demoAccounts(includeAdmins: boolean): Promise<DemoAccount[]> {
    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        OR: [{ employeeId: null }, { employee: { isActive: true, deletedAt: null } }],
        ...(includeAdmins ? {} : { roles: { none: { role: { key: { in: ADMIN_ROLES } } } } }),
      },
      include: PRINCIPAL_INCLUDE,
      orderBy: { username: 'asc' },
    });
    return users.map((u) => ({
      username: u.username,
      displayName: u.employee?.fullName ?? u.username,
      displayNameAr: u.employee?.fullNameAr ?? null,
      roles: [...new Set(u.roles.map((r) => r.role.key))].sort(),
    }));
  }

  async demoLogin(usernameRaw: string, includeAdmins: boolean, meta: RequestMeta): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({ where: { username: usernameRaw.trim().toLowerCase() }, include: PRINCIPAL_INCLUDE });
    if (!user || !isPrincipalActive(user)) throw AppError.notFound('Demo account not found');
    if (!includeAdmins && user.roles.some((r) => ADMIN_ROLES.includes(r.role.key))) throw AppError.notFound('Demo account not found');
    return this.startSession(user, 'WEB', meta, 'DEMO_LOGIN');
  }

  async logout(sessionId: string, userId: string, ip: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.sessions.revoke(tx, sessionId);
      await this.audit.record(tx, { actorUserId: userId, action: 'LOGOUT', entityType: 'Session', entityId: sessionId, ipAddress: ip });
    });
  }

  /** Revokes every session of the user, including the one making the request. */
  async logoutAll(sessionId: string, userId: string, ip: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const revoked = await this.sessions.revokeAllForUser(tx, userId);
      await this.audit.record(tx, {
        actorUserId: userId, action: 'LOGOUT_ALL', entityType: 'User', entityId: userId,
        after: { revokedSessions: revoked, requestSessionId: sessionId }, ipAddress: ip,
      });
    });
  }

  /**
   * Self-service password change. A wrong current password counts as a failed attempt for the
   * (username, IP) limiter. On success the must-change flag is cleared and all OTHER sessions are revoked.
   */
  async changePassword(userId: string, sessionId: string, currentPassword: string, newPassword: string, meta: RequestMeta): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, passwordHash: true } });
    if (!user) throw AppError.unauthorized();

    const ok = await verifyPassword(user.passwordHash, currentPassword);
    if (!ok) {
      const [max, lockMinutes] = await Promise.all([this.settings.get('auth.maxFailedLogins'), this.settings.get('auth.lockoutMinutes')]);
      const pair = this.attempts.registerFailure(user.username, meta.ip, max, lockMinutes);
      await this.audit.record(this.prisma, {
        actorUserId: userId, action: 'PASSWORD_CHANGE_FAILED', entityType: 'User', entityId: userId,
        after: { reason: 'INVALID_CURRENT_PASSWORD', lockedUntil: pair.lockedUntil?.toISOString() ?? null }, ipAddress: meta.ip,
      });
      throw AppError.badRequest('INVALID_CURRENT_PASSWORD', 'The current password is not correct');
    }
    const pairLock = this.attempts.lockedUntil(user.username, meta.ip);
    if (pairLock) throw accountLocked(pairLock);
    if (newPassword === currentPassword) {
      throw AppError.badRequest('PASSWORD_REUSED', 'The new password must be different from the current one');
    }

    const passwordHash = await hashPassword(newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, passwordChangedAt: new Date(), mustChangePassword: false, failedLoginCount: 0, lockedUntil: null },
      });
      const revoked = await this.sessions.revokeAllForUser(tx, userId, sessionId);
      await this.audit.record(tx, {
        actorUserId: userId, action: 'PASSWORD_CHANGE', entityType: 'User', entityId: userId,
        after: { revokedOtherSessions: revoked }, ipAddress: meta.ip,
      });
    });
    this.attempts.clear(user.username, meta.ip);
  }

  async me(userId: string): Promise<SessionUser> {
    const p = await this.sessions.loadPrincipal(this.prisma, userId);
    if (!p) throw AppError.unauthorized();
    // Company-wide employee-portal visibility, so the app can hide turned-off "My work" pages.
    return { ...toSessionUser(p), portal: await this.settings.portalVisibility() };
  }

  async setLocale(userId: string, locale: 'en' | 'ar', ip: string): Promise<SessionUser> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { locale: true } });
      await tx.user.update({ where: { id: userId }, data: { locale } });
      await this.audit.record(tx, {
        actorUserId: userId, action: 'USER_LOCALE_UPDATE', entityType: 'User', entityId: userId,
        before, after: { locale }, ipAddress: ip,
      });
    });
    return this.me(userId);
  }

  /**
   * Counts a wrong password: per (username, IP) in memory, and for existing users also in the database with a
   * single atomic UPDATE ... RETURNING (row lock), so parallel requests cannot skip past the threshold.
   * The database counter is not reset when the lock starts; it restarts after the lock has expired and is
   * cleared by a successful sign-in or password change. Every attempt is audited (never the password).
   */
  private async registerFailure(username: string, user: Principal | null, meta: RequestMeta): Promise<void> {
    const [max, lockMinutes] = await Promise.all([this.settings.get('auth.maxFailedLogins'), this.settings.get('auth.lockoutMinutes')]);
    const wasPairLocked = this.attempts.lockedUntil(username, meta.ip) !== null;
    const pair = this.attempts.registerFailure(username, meta.ip, max, lockMinutes);

    let db: { failedLoginCount: number; lockedUntil: Date | null; newlyLocked: boolean } | null = null;
    if (user) {
      const threshold = max * USER_LOCK_FACTOR;
      const rows = await this.prisma.$queryRaw<{ failed_login_count: number; locked_until: Date | null }[]>`
        UPDATE users SET
          failed_login_count = CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1 ELSE failed_login_count + 1 END,
          locked_until = CASE
            WHEN locked_until IS NOT NULL AND locked_until > now() THEN locked_until
            WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1 ELSE failed_login_count + 1 END) >= ${threshold}::int
              THEN now() + make_interval(mins => ${lockMinutes}::int)
            ELSE NULL
          END,
          updated_at = now()
        WHERE id = ${user.id}::uuid
        RETURNING failed_login_count, locked_until`;
      const row = rows[0];
      if (row) {
        const count = Number(row.failed_login_count);
        db = { failedLoginCount: count, lockedUntil: row.locked_until, newlyLocked: count === threshold && row.locked_until !== null };
      }
    }

    const whileLocked = wasPairLocked || (!!db?.lockedUntil && !db.newlyLocked);
    await this.auditFailure(username, user?.id ?? null, meta, {
      reason: user ? 'BAD_PASSWORD' : 'UNKNOWN_USER',
      whileLocked,
      ...(db ? { failedLoginCount: db.failedLoginCount } : {}),
      ...(pair.newlyLocked ? { lockScope: 'USERNAME_IP', lockedUntil: pair.lockedUntil!.toISOString() } : {}),
      ...(db?.newlyLocked ? { lockScope: 'USER', lockedUntil: db.lockedUntil!.toISOString() } : {}),
    }, pair.newlyLocked || db?.newlyLocked ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED');
  }

  private auditFailure(username: string, userId: string | null, meta: RequestMeta, details: Record<string, unknown>, action = 'LOGIN_FAILED') {
    return this.audit.record(this.prisma, {
      actorUserId: null, action, entityType: 'User', entityId: userId,
      after: { username: username.slice(0, 64), ...details }, ipAddress: meta.ip,
    });
  }

  private async startSession(user: Principal, client: SessionClient, meta: RequestMeta, action: 'LOGIN' | 'DEMO_LOGIN'): Promise<LoginResult> {
    const session = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
      const issued = await this.sessions.issue(tx, user.id, client, meta.ip, meta.userAgent);
      await this.audit.record(tx, {
        actorUserId: user.id, action, entityType: 'Session', entityId: issued.sessionId,
        after: { client, userAgent: meta.userAgent?.slice(0, 200) ?? null }, ipAddress: meta.ip,
      });
      return issued;
    });
    return { session, user: toSessionUser(user), client };
  }
}
