import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode } from '@workforce/shared';

/**
 * Domain error with a stable machine-readable code. The global exception filter turns it into
 * { error: { code, message, details }, statusCode, path, timestamp }.
 */
export class AppError extends HttpException {
  constructor(public readonly code: ErrorCode, message: string, status: HttpStatus, public readonly details?: unknown) {
    super({ code, message, details }, status);
  }
  static badRequest(code: ErrorCode, message: string, details?: unknown) { return new AppError(code, message, HttpStatus.BAD_REQUEST, details); }
  static unauthorized(code: ErrorCode = 'UNAUTHENTICATED', message = 'Authentication required') { return new AppError(code, message, HttpStatus.UNAUTHORIZED); }
  static forbidden(code: ErrorCode = 'FORBIDDEN', message = 'You do not have permission to do this', details?: unknown) { return new AppError(code, message, HttpStatus.FORBIDDEN, details); }
  static notFound(message = 'Not found') { return new AppError('NOT_FOUND', message, HttpStatus.NOT_FOUND); }
  static conflict(code: ErrorCode, message: string, details?: unknown) { return new AppError(code, message, HttpStatus.CONFLICT, details); }
}
