/**
 * Central API client for the MediIndex mobile app.
 *
 * Deliberately the ONLY place that talks to the network, so Phase 7C/7D can add
 * device-token authentication by registering a token provider — no rewrite of
 * the networking layer, and no per-screen fetch calls to audit.
 *
 * Responsibilities:
 *  - GET / POST with JSON encoding and decoding
 *  - per-attempt timeout via AbortController
 *  - structured ApiError (HTTP | NETWORK | TIMEOUT | MALFORMED)
 *  - content-type-aware parsing: a non-JSON body never surfaces as a parse crash
 *    (the same defect class that was fixed on the web client)
 *  - optional device-token header injection
 *  - secret-free logging
 *
 * Phase 7B contains NO business operations — only the transport.
 */

import { config, apiUrl } from '../config/env';
import { logger, safeHeaders } from '../utils/logger';
import { ApiError } from './errors';
import { DEVICE_TOKEN_HEADER } from '../types/api';

/** Supplies the current device token, or null when the device is not paired. */
export type TokenProvider = () => Promise<string | null> | string | null;

/** Called when an authenticated request fails due to an invalid device token. */
export type AuthFailureHandler = (error: ApiError) => Promise<void>;

let tokenProvider: TokenProvider | null = null;
let authFailureHandler: AuthFailureHandler | null = null;

/**
 * Registers the device-token source. Phase 7C wires this to SecureStore.
 * Keeping it injected means the client never imports storage directly.
 */
export function setTokenProvider(provider: TokenProvider | null): void {
  tokenProvider = provider;
}

/**
 * Registers a callback for authentication failures (401 / DEVICE_REVOKED).
 * The handler should clear the device credential and update app state accordingly.
 * 
 * Only one handler can be registered — this is app-global auth failure handling.
 */
export function setAuthFailureHandler(handler: AuthFailureHandler | null): void {
  authFailureHandler = handler;
}

async function resolveToken(): Promise<string | null> {
  if (!tokenProvider) return null;
  try {
    const value = await tokenProvider();
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch (err) {
    logger.warn('api', 'Token provider failed; continuing unauthenticated');
    return null;
  }
}

export interface RequestOptions {
  /** Attach the device token header. Defaults to false. */
  authenticated?: boolean;
  /** Override the default per-attempt timeout. */
  timeoutMs?: number;
  /** Extra headers. Never log these — safeHeaders() redacts on the way out. */
  headers?: Record<string, string>;
  /** Allows a caller (e.g. the sync engine) to cancel an in-flight request. */
  signal?: AbortSignal;
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body: unknown | undefined,
  options: RequestOptions = {},
): Promise<T> {
  const url = apiUrl(path);
  const timeoutMs = options.timeoutMs ?? config.requestTimeoutMs;

  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (options.authenticated) {
    const token = await resolveToken();
    if (token) headers[DEVICE_TOKEN_HEADER] = token;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Honour an externally supplied signal in addition to the timeout.
  const externalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', externalAbort);

  logger.debug('api', `${method} ${path}`, { headers: safeHeaders(headers) });

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = (err as Error)?.name === 'AbortError';
    if (aborted) throw new ApiError('TIMEOUT', `Request timed out after ${timeoutMs}ms.`);
    throw new ApiError('NETWORK', 'Could not reach the MediIndex server. Check your connection.');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', externalAbort);
  }

  // Read as text first — the body may not be JSON (proxy page, auth gateway, crash).
  const raw = await response.text().catch(() => '');
  const contentType = response.headers.get('content-type') ?? '';
  const looksJson = contentType.includes('application/json');

  let parsed: unknown = null;
  if (looksJson && raw) {
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
  }

  if (!response.ok) {
    const bodyObj = (parsed ?? {}) as { error?: string; code?: string; errorCode?: string; details?: unknown };
    const message = bodyObj.error
      ?? (response.status === 401 ? 'This device is not authorised. Please pair it again.'
        : response.status === 403 ? 'This device does not have permission for that action.'
        : response.status === 404 ? 'The requested resource was not found.'
        : response.status >= 500 ? 'The MediIndex server is temporarily unavailable.'
        : `Request failed (HTTP ${response.status}).`);
    const error = new ApiError('HTTP', message, {
      status: response.status,
      code: bodyObj.code ?? bodyObj.errorCode,
      details: bodyObj.details,
    });
    logger.warn('api', `${method} ${path} -> ${response.status}`, { code: error.code });

    // Phase 7D: Centralized authentication failure handling
    if (options.authenticated && authFailureHandler && error.isAuthFailure) {
      logger.warn('api', 'Authenticated request failed with auth error; invoking failure handler');
      try {
        await authFailureHandler(error);
      } catch (handlerErr) {
        logger.warn('api', 'Auth failure handler threw an error', { error: handlerErr });
      }
    }

    throw error;
  }

  if (!looksJson || parsed === null) {
    throw new ApiError('MALFORMED', 'The server returned an unexpected response.', { status: response.status });
  }

  logger.debug('api', `${method} ${path} -> ${response.status}`);
  return parsed as T;
}

export const apiClient = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('POST', path, body, options),
  setTokenProvider,
  setAuthFailureHandler,
};

export type ApiClient = typeof apiClient;
