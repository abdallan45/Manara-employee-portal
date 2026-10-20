import { API_PREFIX, ERROR_CODES, type ApiErrorBody, type ErrorCode } from '@workforce/shared';

/** Client-side error codes for failures that never reached (or never came back from) the API. */
export type ClientErrorCode = 'NETWORK_ERROR' | 'UNKNOWN';
export type AnyErrorCode = ErrorCode | ClientErrorCode;

/** Typed error thrown by every API call. `status` is 0 when the request never got a response. */
export class ApiError extends Error {
  readonly code: AnyErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: AnyErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** True when no server response was received - the caller may retry with the same idempotency key. */
  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  /** Do not broadcast a session-expired event on 401 (used by login/me probes). */
  silentAuth?: boolean;
}

export const UNAUTHENTICATED_EVENT = 'wf:unauthenticated';
/** Broadcast when any call answers 403 PASSWORD_CHANGE_REQUIRED (the session user must set a new password). */
export const PASSWORD_CHANGE_REQUIRED_EVENT = 'wf:password-change-required';

const CSRF_COOKIE = 'wf_csrf';

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function buildQuery(query: Query | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const err = (value as { error?: unknown }).error;
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string';
}

function codeFromStatus(status: number): AnyErrorCode {
  switch (status) {
    case 400:
    case 422:
      return 'VALIDATION_FAILED';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 423:
      return 'ACCOUNT_LOCKED';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'UNKNOWN';
  }
}

/** Single typed entry point for the `/api/v1` API. Paths are relative to the prefix, e.g. `/auth/me`. */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  // FormData (file uploads) sets its own multipart Content-Type with the boundary.
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (options.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${path}${buildQuery(options.query)}`, {
      method,
      headers,
      body: isForm ? (options.body as FormData) : options.body !== undefined ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('NETWORK_ERROR', 0, err instanceof Error ? err.message : 'Network error');
  }

  if (res.status === 204) return undefined as T;

  let payload: unknown = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    let error: ApiError;
    if (isApiErrorBody(payload)) {
      const code = isErrorCode(payload.error.code) ? payload.error.code : codeFromStatus(res.status);
      error = new ApiError(code, res.status, payload.error.message, payload.error.details);
    } else {
      error = new ApiError(codeFromStatus(res.status), res.status, res.statusText || `HTTP ${res.status}`);
    }
    if (res.status === 401 && !options.silentAuth && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(UNAUTHENTICATED_EVENT));
    }
    if (res.status === 403 && error.code === 'PASSWORD_CHANGE_REQUIRED' && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(PASSWORD_CHANGE_REQUIRED_EVENT));
    }
    throw error;
  }

  return payload as T;
}

export const apiGet = <T>(path: string, query?: Query, signal?: AbortSignal) => api<T>(path, { query, signal });
export const apiPost = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body ?? {} });
export const apiPatch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const apiDelete = <T>(path: string) => api<T>(path, { method: 'DELETE' });

/**
 * Best-effort extraction of field-level messages from a VALIDATION_FAILED `details` payload.
 * Accepts `{ field: message | message[] }`, `{ fields: {...} }` or
 * `[{ field|property, message|messages|constraints }]` (class-validator style).
 */
export function fieldErrorsFrom(details: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (field: unknown, msg: unknown) => {
    if (typeof field !== 'string') return;
    if (typeof msg === 'string') out[field] = msg;
    else if (Array.isArray(msg) && typeof msg[0] === 'string') out[field] = msg[0];
    else if (typeof msg === 'object' && msg !== null) {
      const first = Object.values(msg)[0];
      if (typeof first === 'string') out[field] = first;
    }
  };
  if (Array.isArray(details)) {
    for (const item of details) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      put(rec.field ?? rec.property ?? rec.path, rec.message ?? rec.messages ?? rec.constraints);
    }
  } else if (typeof details === 'object' && details !== null) {
    const rec = details as Record<string, unknown>;
    const source = typeof rec.fields === 'object' && rec.fields !== null ? (rec.fields as Record<string, unknown>) : rec;
    for (const [k, v] of Object.entries(source)) put(k, v);
  }
  return out;
}
