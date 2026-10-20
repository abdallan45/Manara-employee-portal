import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { webDistCandidates } from './static-web';

/** File the web build writes next to index.html: hashes of every inline <script> in the exported HTML. */
export const CSP_HASHES_FILE = 'csp-hashes.json';
const HASH_SOURCE = /^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

/**
 * CSP for a self-hosted Next.js static export. Next inlines bootstrap scripts; when the build
 * provides their hashes, script-src allows 'self' (external scripts such as locale-init.js) plus
 * exactly those inline scripts, otherwise it falls back to 'unsafe-inline'. Styles keep
 * 'unsafe-inline' (Next inlines style attributes). Everything else is same-origin only.
 */
export function buildCsp(scriptHashes: readonly string[] | null): string {
  const script = scriptHashes ? ["'self'", ...scriptHashes.map((h) => `'${h}'`)].join(' ') : "'self' 'unsafe-inline'";
  return [
    "default-src 'self'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const statFile = (p: string) => { try { const s = statSync(p); return s.isFile() ? s : null; } catch { return null; } };

/** The hash file of the web build the static middleware serves (first candidate with an index.html), or null. */
function hashFileOf(candidates: readonly string[]): string | null {
  const root = candidates.find((c) => statFile(join(c, 'index.html')));
  return root ? join(root, CSP_HASHES_FILE) : null;
}

/** Parses the hash file; null hashes, with the reason, when it is missing or malformed. */
export function readCspScriptHashes(file: string | null): { hashes: string[] | null; problem: string | null } {
  if (!file) return { hashes: null, problem: 'web build not found' };
  if (!statFile(file)) return { hashes: null, problem: `${file} is missing` };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { script?: unknown } | null;
    const list = parsed?.script;
    if (!Array.isArray(list) || !list.every((h): h is string => typeof h === 'string' && HASH_SOURCE.test(h))) {
      return { hashes: null, problem: `${file} must be {"script": ["sha256-<base64>", ...]}` };
    }
    return { hashes: [...new Set(list)], problem: null };
  } catch (err) {
    return { hashes: null, problem: `${file} could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface CspProviderOptions {
  /** Web build folders to look in (default: the static middleware's candidates). */
  candidates?: readonly string[];
  /** Minimum time between file checks. */
  checkIntervalMs?: number;
  now?: () => number;
  logger?: Pick<Logger, 'warn' | 'log'>;
}

/**
 * Returns a function giving the current CSP. The web app is rebuilt while the API keeps running
 * and every build changes the inline-script hashes, so the hash file is re-read whenever its
 * mtime or size changes. The check is one stat call, done at most once per interval.
 */
export function createCspProvider(options: CspProviderOptions = {}): () => string {
  const candidates = options.candidates ?? webDistCandidates();
  const interval = options.checkIntervalMs ?? 5000;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? new Logger('SecurityHeaders');
  let csp = buildCsp(null);
  let checkedAt = Number.NEGATIVE_INFINITY;
  let version: string | null = null; // file + mtime + size of the last read, or 'missing'

  return () => {
    const t = now();
    if (t - checkedAt < interval) return csp;
    checkedAt = t;
    const file = hashFileOf(candidates);
    const st = file ? statFile(file) : null;
    const current = st && file ? `${file}|${st.mtimeMs}|${st.size}` : `missing|${file ?? ''}`;
    if (current === version) return csp;
    version = current;
    const { hashes, problem } = readCspScriptHashes(file);
    csp = buildCsp(hashes);
    if (problem) logger.warn(`CSP uses script-src 'unsafe-inline': ${problem}`);
    else logger.log(`CSP script-src allows ${hashes!.length} inline script hash(es) from ${file}`);
    return csp;
  };
}

let currentCsp: (() => string) | null = null;

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  currentCsp ??= createCspProvider();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', currentCsp());
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(self), payment=(), usb=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
}
