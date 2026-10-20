import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ApiErrorBody, ErrorCode } from '@workforce/shared';
import type { Request, Response } from 'express';
import { AppError } from '../app-error';

const STATUS_CODES: Partial<Record<number, ErrorCode>> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};

/** Turns every error into the ApiErrorBody envelope. Unexpected errors are logged and returned as a bare 500. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const { status, code, message, details } = this.describe(exception, req);

    const body: ApiErrorBody = {
      error: details === undefined ? { code, message } : { code, message, details },
      statusCode: status,
      path: req.originalUrl ?? req.url,
      timestamp: new Date().toISOString(),
    };
    if (res.headersSent) return;
    res.status(status).json(body);
  }

  private describe(exception: unknown, req: Request): { status: number; code: ErrorCode; message: string; details?: unknown } {
    if (exception instanceof AppError) {
      return { status: exception.getStatus(), code: exception.code, message: exception.message, details: exception.details };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // Only multer (file uploads) raises 413 as an HttpException; JSON bodies are handled below.
      if (status === 413) return { status, code: 'ATTACHMENT_TOO_LARGE', message: 'The file is too large' };
      const code = STATUS_CODES[status];
      if (code) {
        const response = exception.getResponse();
        let message = exception.message;
        let details: unknown;
        if (typeof response === 'object' && response !== null) {
          const m = (response as { message?: unknown }).message;
          if (Array.isArray(m)) { details = m; message = 'Validation failed'; }
          else if (typeof m === 'string') message = m;
        }
        if (status === 429) message = 'Too many requests, please slow down';
        return { status, code, message, details };
      }
      if (status < 500) return { status, code: 'VALIDATION_FAILED', message: exception.message };
    }
    // Body-parser errors (malformed JSON, payload too large) carry a numeric status/statusCode.
    const raw = exception as { status?: unknown; type?: unknown } | null;
    // Messages are fixed strings: parser messages can echo fragments of the body.
    if (raw && typeof raw.status === 'number' && raw.status >= 400 && raw.status < 500 && typeof raw.type === 'string') {
      if (raw.status === 413) return { status: 413, code: 'VALIDATION_FAILED', message: 'Payload too large' };
      if (raw.status === 415) return { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported request body encoding' };
      if (raw.type === 'entity.parse.failed') return { status: 400, code: 'VALIDATION_FAILED', message: 'Malformed JSON body' };
      return { status: raw.status, code: 'VALIDATION_FAILED', message: 'Malformed request body' };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        // Constraint / column names stay in the server log; clients only learn that it is a duplicate.
        this.logger.warn(`Unique constraint violation on ${req.method} ${req.originalUrl ?? req.url}: ${JSON.stringify(exception.meta?.target ?? null)}`);
        return { status: HttpStatus.CONFLICT, code: 'CONFLICT', message: 'A record with these values already exists' };
      }
      if (exception.code === 'P2025') return { status: HttpStatus.NOT_FOUND, code: 'NOT_FOUND', message: 'Not found' };
    }
    this.logger.error(
      `Unhandled error on ${req.method} ${req.originalUrl ?? req.url}`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: 'INTERNAL_ERROR', message: 'Internal server error' };
  }
}
