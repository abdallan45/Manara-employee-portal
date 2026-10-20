import { HttpStatus } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../app-error';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_BODY_TYPES = new Set(['application/json', 'multipart/form-data']);

const hasBody = (req: Request): boolean => {
  const length = req.headers['content-length'];
  if (length !== undefined && Number(length) > 0) return true;
  return req.headers['transfer-encoding'] !== undefined;
};

const mediaType = (req: Request): string => (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();

/**
 * The host the browser addressed. X-Forwarded-Host is honoured only when the TCP peer is a trusted proxy
 * (TRUSTED_PROXIES / Express "trust proxy"), so a direct client cannot fake same-origin with it.
 */
function expectedHost(req: Request): string | undefined {
  const trust = req.app?.get('trust proxy fn') as ((addr: string, i: number) => boolean) | undefined;
  const forwarded = req.headers['x-forwarded-host'];
  if (forwarded && trust?.(req.socket?.remoteAddress ?? '', 0)) {
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(',')[0].trim();
    if (first) return first;
  }
  return req.headers.host;
}

/** True when the Origin header names the same scheme-less host[:port] the request was sent to. */
export function isSameOrigin(origin: string, host: string | undefined): boolean {
  if (!host || origin === 'null') return false;
  try {
    const o = new URL(origin);
    // Normalise the Host header through the Origin's scheme so default ports (:80/:443) compare equal.
    const h = new URL(`${o.protocol}//${host}`);
    return o.host.toLowerCase() === h.host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Extra origins allowed to send unsafe requests besides the API's own host, from ALLOWED_ORIGINS
 * (comma-separated, e.g. "http://localhost:3001" for `next dev`, whose proxy rewrites the Host header).
 */
export function allowedOrigins(raw = process.env.ALLOWED_ORIGINS): Set<string> {
  const out = new Set<string>();
  for (const entry of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    try { out.add(new URL(entry).origin.toLowerCase()); } catch { /* ignore malformed entries */ }
  }
  return out;
}

/**
 * Global request checks that must run before body parsing and before any route (including @Public login
 * and demo login):
 *  - Unsafe methods carrying a body must be application/json or multipart/form-data (415 otherwise).
 *    This blocks HTML-form (urlencoded / text/plain) posts, which browsers send cross-site without a preflight.
 *  - Unsafe methods from a browser that is cross-site (Sec-Fetch-Site: cross-site) or whose Origin is not this
 *    host are refused with 403 CSRF_FAILED. Requests without Origin (curl, native mobile apps) are allowed.
 */
export function requestGuards(req: Request, _res: Response, next: NextFunction): void {
  if (!UNSAFE_METHODS.has(req.method)) return next();

  if (req.headers['sec-fetch-site'] === 'cross-site') {
    return next(AppError.forbidden('CSRF_FAILED', 'Cross-site request refused'));
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !isSameOrigin(origin, expectedHost(req)) && !allowedOrigins().has(origin.toLowerCase())) {
    return next(AppError.forbidden('CSRF_FAILED', 'Cross-origin request refused'));
  }

  if (hasBody(req) && !ALLOWED_BODY_TYPES.has(mediaType(req))) {
    return next(new AppError('UNSUPPORTED_MEDIA_TYPE', 'Send the request body as application/json (or multipart/form-data for uploads)', HttpStatus.UNSUPPORTED_MEDIA_TYPE));
  }
  next();
}

/**
 * Error middleware mounted right after the JSON body parser. Nest would turn a body-parser SyntaxError into a
 * BadRequestException carrying the parser's message (which echoes parts of the body); replace parser errors
 * with fixed, generic AppErrors before that happens.
 */
export function bodyParserErrors(err: unknown, _req: Request, _res: Response, next: NextFunction): void {
  const e = err as { type?: unknown; status?: unknown } | null;
  if (!e || typeof e.type !== 'string' || typeof e.status !== 'number') return next(err);
  if (e.type === 'entity.parse.failed') return next(AppError.badRequest('VALIDATION_FAILED', 'Malformed JSON body'));
  if (e.status === 413) return next(new AppError('VALIDATION_FAILED', 'Payload too large', HttpStatus.PAYLOAD_TOO_LARGE));
  if (e.status === 415) return next(new AppError('UNSUPPORTED_MEDIA_TYPE', 'Unsupported request body encoding', HttpStatus.UNSUPPORTED_MEDIA_TYPE));
  return next(AppError.badRequest('VALIDATION_FAILED', 'Malformed request body'));
}
