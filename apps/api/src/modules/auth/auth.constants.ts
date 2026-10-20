export const SESSION_COOKIE = 'wf_session';
export const CSRF_COOKIE = 'wf_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** lastSeenAt is refreshed at most this often per session. */
export const LAST_SEEN_THROTTLE_MS = 60_000;

const envInt = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
/** Requests per minute per IP for the whole API. */
export const apiRateLimit = () => envInt('RATE_LIMIT_PER_MINUTE', 300);
/** Requests per minute per IP for login and demo login. */
export const loginRateLimit = () => envInt('RATE_LIMIT_LOGIN_PER_MINUTE', 10);
/**
 * Integration tests log in far more often than a person would, so throttling is off under
 * NODE_ENV=test unless a test opts in with RATE_LIMIT_IN_TESTS=true.
 */
export const throttlingDisabled = () => process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_IN_TESTS !== 'true';

/**
 * One-click demo login. Never available when NODE_ENV=production, whatever DEMO_MODE says
 * (see logDemoModeStatus for the startup error/warning).
 */
export const isDemoMode = () => process.env.DEMO_MODE === 'true' && process.env.NODE_ENV !== 'production';
/** Demo endpoints answer non-loopback peers only when DEMO_ALLOW_REMOTE=true. */
export const demoAllowsRemote = () => process.env.DEMO_ALLOW_REMOTE === 'true';
/** SUPER_ADMIN / HR_ADMIN accounts are offered for demo login only when DEMO_INCLUDE_ADMINS=true. */
export const demoIncludesAdmins = () => process.env.DEMO_INCLUDE_ADMINS === 'true';

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/**
 * True when the TCP peer is this machine. Deliberately the socket address, NOT req.ip: X-Forwarded-For
 * from a trusted proxy (or a spoofed one) must never make a remote caller look local.
 */
export const isLoopbackPeer = (req: { socket?: { remoteAddress?: string | null } | null }): boolean =>
  LOOPBACK_PEERS.has(req.socket?.remoteAddress ?? '');

/** Startup diagnostics for demo mode; returns whether demo login is effectively enabled. */
export function logDemoModeStatus(logger: { error(msg: string): unknown; warn(msg: string): unknown }): boolean {
  if (process.env.DEMO_MODE !== 'true') return false;
  if (process.env.NODE_ENV === 'production') {
    logger.error('DEMO_MODE=true is IGNORED because NODE_ENV=production. Remove DEMO_MODE from the production environment.');
    return false;
  }
  logger.warn(
    'DEMO MODE IS ON: one-click login without a password is enabled ' +
    `(${demoAllowsRemote() ? 'from ANY network peer (DEMO_ALLOW_REMOTE=true)' : 'from loopback only'}; ` +
    `${demoIncludesAdmins() ? 'admin accounts INCLUDED (DEMO_INCLUDE_ADMINS=true)' : 'admin accounts excluded'}). Never use this on a real deployment.`,
  );
  return true;
}
