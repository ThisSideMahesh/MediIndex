/**
 * Structured API errors, plus the transient/permanent classification the
 * Phase 7I/7J sync engine will use to decide whether a receipt may be retried.
 *
 * The classification mirrors the already-proven web implementation in
 * `public/sync.js` so mobile and web behave identically.
 */

import type { MediIndexErrorCode } from '../types/api';

export type ApiErrorKind =
  /** Reached the server; it returned a non-2xx JSON error. */
  | 'HTTP'
  /** Never reached the server (offline, DNS, connection refused). */
  | 'NETWORK'
  /** Request exceeded the configured timeout. */
  | 'TIMEOUT'
  /** 2xx but the body was not the JSON we expected. */
  | 'MALFORMED';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(kind: ApiErrorKind, message: string, opts: { status?: number; code?: string; details?: unknown } = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
  }

  /** True when the device token was rejected — caller should force re-pairing. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.code === 'DEVICE_REVOKED';
  }
}

/**
 * Server error codes that will never succeed on retry.
 * Matches PERMANENT_ERROR_CODES in public/sync.js.
 *
 * DEVICE_REVOKED is deliberately NOT in this set — it is an authentication
 * failure (see AUTHENTICATION_ERROR_CODES below), a distinct category from a
 * permanent validation/business error. Both are non-retryable automatically,
 * but they need different classification because they need different UX and
 * different recovery paths (re-pairing vs. fixing the request data).
 */
export const PERMANENT_ERROR_CODES: ReadonlySet<string> = new Set<MediIndexErrorCode | string>([
  'MEDICINE_NOT_FOUND',
  'BATCH_NOT_FOUND',
  'INVALID_QR_PAYLOAD',
  'INVALID_QUANTITY',
  'QUANTITY_LIMIT_EXCEEDED',
  'QUANTITY_REQUIRED',
  'INVALID_IDEMPOTENCY_KEY',
  'TENANT_SPOOFING_REJECTED',
  'IDEMPOTENCY_CONFLICT',
]);

/**
 * Server error codes and HTTP statuses that mean the DEVICE's credential is
 * the problem, not the request payload. Phase 7J's own category (requirement
 * 2B): must not retry forever, must not silently mint a new credential, must
 * preserve the queued operation, and must surface "authentication must be
 * restored" rather than a generic failure.
 */
export const AUTHENTICATION_ERROR_CODES: ReadonlySet<string> = new Set<MediIndexErrorCode | string>([
  'DEVICE_REVOKED',
]);
export const AUTHENTICATION_HTTP_STATUSES: ReadonlySet<number> = new Set([401]);

/** HTTP statuses that indicate a client-side problem — retrying cannot help.
 *  401 is intentionally excluded: it is classified separately, see isAuthenticationFailure(). */
export const PERMANENT_HTTP_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 409, 422]);

/**
 * True when the failure means the device's credential was rejected or revoked
 * — a 401, or the DEVICE_REVOKED error code the backend also returns on some
 * non-401 paths (see core.js's DEVICE_REVOKED checks inside the stock-entry
 * transaction). Distinct from `isTransient` and from ordinary permanent
 * validation failures: this is specifically "re-pair this device," not
 * "fix the request" or "try again later."
 */
export function isAuthenticationFailure(error: unknown): boolean {
  if (error instanceof ApiError) {
    if (error.isAuthFailure) return true;
    if (typeof error.status === 'number' && AUTHENTICATION_HTTP_STATUSES.has(error.status)) return true;
    if (error.code && AUTHENTICATION_ERROR_CODES.has(error.code)) return true;
  }
  return false;
}

/**
 * Whether a failed attempt may be retried with the SAME idempotency key.
 * Network and timeout failures are transient by definition: the server may or
 * may not have processed the receipt, which is exactly what idempotency covers.
 *
 * Authentication failures are NOT transient (they must not be retried on the
 * usual backoff schedule — retrying with the same invalid/revoked credential
 * cannot succeed), but they are also not an ordinary permanent validation
 * failure. Callers should check `isAuthenticationFailure()` first.
 */
export function isTransient(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (isAuthenticationFailure(error)) return false;
  if (error.kind === 'NETWORK' || error.kind === 'TIMEOUT') return true;
  if (error.kind === 'MALFORMED') return true;
  if (error.code && PERMANENT_ERROR_CODES.has(error.code)) return false;
  if (typeof error.status === 'number' && PERMANENT_HTTP_STATUSES.has(error.status)) return false;
  // Remaining HTTP failures (5xx, 429, ...) are worth another attempt.
  return true;
}

/**
 * Error category used for both internal branching and any future UI/logging
 * needs, per Phase 7J requirement 2. Computed from an unknown thrown value.
 */
export type ErrorCategory = 'RETRYABLE' | 'AUTHENTICATION' | 'PERMANENT' | 'UNKNOWN';

export function classifyError(error: unknown): ErrorCategory {
  if (!(error instanceof ApiError)) return 'UNKNOWN';
  if (isAuthenticationFailure(error)) return 'AUTHENTICATION';
  if (isTransient(error)) return 'RETRYABLE';
  return 'PERMANENT';
}

/**
 * Maps a technical error to a short, safe, user-facing message. Never echoes
 * the raw error text (which could contain a stack fragment, a header name, a
 * SQL fragment surfaced by a 500, or a filesystem path) — see Phase 7J
 * requirement 14. Full technical detail still goes to `logger.*`, never to UI.
 */
export function toUserMessage(error: unknown, category: ErrorCategory = classifyError(error)): string {
  switch (category) {
    case 'AUTHENTICATION':
      return 'This device needs to be paired again before it can sync stock receipts.';
    case 'RETRYABLE':
      return 'Could not reach the MediIndex server. This will be retried automatically.';
    case 'PERMANENT':
      if (error instanceof ApiError && error.code === 'IDEMPOTENCY_CONFLICT') {
        return 'This operation could not be synced due to a conflict and needs attention.';
      }
      return 'This stock receipt could not be processed and needs attention.';
    default:
      return 'An unexpected error occurred.';
  }
}

/**
 * A small, explicit allow-list of PERMANENT-category error messages that
 * `POST /api/mobile/stock-entry` (core.js's processMobileStockEntry) is known
 * to return verbatim in its `{ error: string }` body. That endpoint does not
 * send a machine-readable `code` field, so `ApiError.code` is always
 * undefined for it — `toUserMessage()` therefore falls through to one generic
 * sentence for every permanent failure, discarding backend text like
 * "Active medicine ID 12 not found for this pharmacy." that is already safe
 * to show (no SQL, no stack trace, no secret) and far more actionable than
 * the generic fallback.
 *
 * This is intentionally a PATTERN allow-list, not a blanket "trust
 * error.message" rule: only messages matching these known, hand-reviewed
 * shapes are surfaced verbatim. Anything else (a raw 500, a message we don't
 * recognise) still falls back to the safe generic text from `toUserMessage`,
 * so a future backend change that starts leaking internal detail cannot
 * reach the UI just because it also returns a PERMANENT-classified status.
 */
const STOCK_RECEIPT_SAFE_MESSAGE_PATTERNS: ReadonlyArray<RegExp> = [
  // "Active medicine ID 12 not found for this pharmacy." (processMobileStockEntry)
  // "Medicine ID 12 not found for this pharmacy." (POST /api/mobile/qr/lookup)
  /^(?:Active )?[Mm]edicine ID \d+ not found for this pharmacy\.$/,
  /^Batch '.*' not found for medicine '.*'\.$/,
  /^Quantity must be a positive whole number greater than zero\.$/,
  /^Quantity exceeds maximum allowable limit of [\d,]+ units per intake transaction\.$/,
  /^Quantity is required\.$/,
  /^Device has been revoked or is no longer authorized\.$/,
  /^Device authentication required\. Invalid or revoked device token\.$/,
  /^Idempotency key conflict: This idempotency key was previously used with a different request payload\.$/,
  /^Invalid QR payload: .*$/,
  /^Invalid medicine ID in QR payload\.$/,
  /^Unrecognized application tag\. Expected MEDIINDEX\.$/,
  /^Unsupported QR version: .*$/,
];

/**
 * Stock-receipt-specific message mapper. Behaves exactly like
 * `toUserMessage()` for AUTHENTICATION/RETRYABLE/UNKNOWN, but for PERMANENT
 * failures returns the backend's own message when (and only when) it matches
 * the reviewed allow-list above — e.g. "Medicine not found", "Batch not
 * found", "Invalid quantity" — instead of a single generic sentence. Falls
 * back to `toUserMessage()`'s generic text for anything unrecognised.
 */
export function toStockReceiptUserMessage(error: unknown, category: ErrorCategory = classifyError(error)): string {
  if (category === 'PERMANENT' && error instanceof ApiError && typeof error.message === 'string') {
    const trimmed = error.message.trim();
    if (STOCK_RECEIPT_SAFE_MESSAGE_PATTERNS.some(pattern => pattern.test(trimmed))) {
      return trimmed;
    }
  }
  return toUserMessage(error, category);
}
