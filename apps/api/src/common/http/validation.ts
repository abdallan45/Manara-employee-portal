import { ValidationError, ValidationPipe } from '@nestjs/common';
import { AppError } from '../app-error';

export interface FieldError { field: string; messages: string[] }

function flatten(errors: ValidationError[], parent = ''): FieldError[] {
  const out: FieldError[] = [];
  for (const e of errors) {
    const field = parent ? `${parent}.${e.property}` : e.property;
    if (e.constraints) out.push({ field, messages: Object.values(e.constraints) });
    if (e.children?.length) out.push(...flatten(e.children, field));
  }
  return out;
}

export const createValidationPipe = () =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) => AppError.badRequest('VALIDATION_FAILED', 'Validation failed', flatten(errors)),
  });
