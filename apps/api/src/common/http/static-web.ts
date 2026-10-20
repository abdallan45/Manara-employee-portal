import { statSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/** Candidate locations of the Next.js static export, whether running from src (ts-node) or dist/src. */
export function webDistCandidates(): string[] {
  const override = process.env.WEB_DIST?.trim();
  if (override) return [isAbsolute(override) ? override : resolve(process.cwd(), override)];
  return [
    resolve(__dirname, '../../../../web/out'),    // apps/api/src/common/http -> apps/web/out
    resolve(__dirname, '../../../../../web/out'), // apps/api/dist/src/common/http -> apps/web/out
    resolve(process.cwd(), 'apps/web/out'),       // started from the repo root
    resolve(process.cwd(), '../web/out'),         // started from apps/api
  ];
}

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

/**
 * Serves the static web build for non-API GET/HEAD requests. Resolves directories to index.html
 * (Next export with trailingSlash) and falls back to 404.html. The folder is looked up lazily so
 * the API runs fine before the web app has been built.
 */
export function staticWebMiddleware() {
  const candidates = webDistCandidates();
  const logger = new Logger('StaticWeb');
  let root: string | null = null;
  let warned = false;

  const findRoot = (): string | null => {
    if (root && isFile(join(root, 'index.html'))) return root;
    root = candidates.find((c) => isFile(join(c, 'index.html'))) ?? null;
    if (!root && !warned) {
      warned = true;
      logger.warn(`Web build not found yet (looked in: ${candidates.join(', ')})`);
    }
    return root;
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path === '/api' || req.path.startsWith('/api/')) return next();
    const base = findRoot();
    if (!base) return next();

    let rel: string;
    try { rel = decodeURIComponent(req.path); } catch { return next(); }
    if (rel.includes('\0')) return next();
    if (rel.split('/').some((segment) => segment.startsWith('.'))) return next();
    const target = normalize(join(base, rel));
    if (target !== base && !target.startsWith(base + sep)) return next();

    let file: string | null = null;
    if (isFile(target)) file = target;
    else if (isFile(join(target, 'index.html'))) file = join(target, 'index.html');
    else if (isFile(`${target}.html`)) file = `${target}.html`;

    let status = 200;
    if (!file) {
      const notFound = join(base, '404.html');
      if (!isFile(notFound)) return next();
      file = notFound;
      status = 404;
    }
    res.status(status);
    res.setHeader('Cache-Control', rel.startsWith('/_next/static/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    // Dot segments in the request were rejected above; 'allow' keeps a web root under a dot-directory working.
    res.sendFile(file, { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  };
}
