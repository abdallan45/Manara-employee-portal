import { INestApplication, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { Application, NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import ipaddr from 'ipaddr.js';
import { ApiExceptionFilter } from './common/http/exception.filter';
import { bodyParserErrors, requestGuards } from './common/http/request-guards';
import { securityHeaders } from './common/http/security-headers';
import { staticWebMiddleware } from './common/http/static-web';
import { createValidationPipe } from './common/http/validation';
import { logDemoModeStatus, SESSION_COOKIE } from './modules/auth/auth.constants';

/** JSON body limit (body-parser's default, kept explicit). Uploads go through multer with their own limits. */
export const JSON_BODY_LIMIT = '100kb';

/** Swagger UI / OpenAPI JSON are served outside production, or in production only with SWAGGER=true. */
export const swaggerEnabled = (env: NodeJS.ProcessEnv = process.env) => env.NODE_ENV !== 'production' || env.SWAGGER === 'true';

/**
 * Nest registers express.json + express.urlencoded at init unless a middleware with the same function name
 * is already mounted. This named no-op takes the urlencoded slot so HTML-form bodies are never parsed
 * (requestGuards already answers them with 415).
 */
function urlencodedParser(_req: Request, _res: Response, next: NextFunction): void {
  next();
}

const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * Parses TRUSTED_PROXIES (comma-separated IPs, CIDRs or the Express keywords loopback/linklocal/uniquelocal).
 * Returns false when unset so X-Forwarded-For is never trusted by default.
 */
export function parseTrustedProxies(raw: string | undefined): false | string[] {
  const entries = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) return false;
  for (const entry of entries) {
    if (PROXY_KEYWORDS.has(entry)) continue;
    const ok = entry.includes('/') ? (() => { try { ipaddr.parseCIDR(entry); return true; } catch { return false; } })() : ipaddr.isValid(entry);
    if (!ok) throw new Error(`TRUSTED_PROXIES: invalid entry "${entry}"`);
  }
  return entries;
}

/**
 * Applies global configuration shared by main.ts and integration tests:
 * trust proxy, cookies, request guards, body parsing, validation pipe, exception filter, API prefix,
 * Swagger (not in production unless SWAGGER=true), static web app, demo-mode startup diagnostics.
 */
export function configureApp(app: INestApplication): void {
  const express = app.getHttpAdapter().getInstance() as Application;
  express.set('trust proxy', parseTrustedProxies(process.env.TRUSTED_PROXIES));
  express.disable('x-powered-by');

  app.use(securityHeaders);
  app.use(cookieParser());
  app.use(staticWebMiddleware());
  // Content-type + Origin checks run before any body parsing and before every route, @Public ones included.
  app.use(requestGuards);
  (app as NestExpressApplication).useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.use(bodyParserErrors);
  app.use(urlencodedParser);

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new ApiExceptionFilter());

  if (swaggerEnabled()) setupSwagger(app);
  logDemoModeStatus(new Logger('DemoMode'));
}

function setupSwagger(app: INestApplication): void {
  try {
    const config = new DocumentBuilder()
      .setTitle('Workforce API')
      .setDescription(
        'Attendance & workforce platform. Web clients authenticate with the HttpOnly session cookie and must send ' +
        'X-CSRF-Token on state-changing requests; mobile clients use a bearer token.',
      )
      .setVersion('1')
      .addCookieAuth(SESSION_COOKIE, { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE }, 'cookie')
      .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'Opaque session token from POST /auth/login with client=MOBILE' }, 'bearer')
      .addSecurityRequirements('cookie')
      .addSecurityRequirements('bearer')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/docs-json' });
  } catch (err) {
    // API documentation must never prevent the API from starting.
    new Logger('Swagger').error('Failed to build the OpenAPI document', err instanceof Error ? err.stack : String(err));
  }
}
