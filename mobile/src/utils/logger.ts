/**
 * Development logger with mandatory secret redaction.
 *
 * HARD RULE: device tokens, Authorization headers and pairing codes must never
 * reach the console. Everything logged goes through redact() first, and header
 * objects are filtered by name so a token cannot leak by accident.
 */

import { config } from '../config/env';

/** Header names whose values must never be printed. */
const SENSITIVE_HEADERS = new Set(['authorization', 'x-device-token', 'cookie', 'set-cookie']);

/** Key names whose values must never be printed. */
const SENSITIVE_KEYS = /^(devicetoken|device_token|token|tokenhash|token_hash|password|pairingcode|pairing_code|authorization|cookie|secret)$/i;

const REDACTED = '[redacted]';

/** Replaces sensitive values anywhere in a structure. Never mutates the input. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    // Defence in depth: a raw device token is recognisable by its prefix.
    return value.startsWith('medidev_') ? REDACTED : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.test(key) ? REDACTED : redact(val, depth + 1);
  }
  return out;
}

/** Returns a copy of headers with sensitive values removed. */
export function safeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTED : val;
  }
  return out;
}

/**
 * Phase 7J (requirement 14): sanitizes a free-text error message before it is
 * persisted to SQLite (`outbox.lastError`) or shown to the user. Unlike
 * `redact()` above (which redacts by KEY name in structured objects), this
 * scans arbitrary text for the SHAPES of things that must never surface:
 * device tokens, Authorization/cookie header values, absolute filesystem
 * paths, and raw SQL statements a 500 error might have echoed. It is
 * deliberately conservative — it can over-redact, but must never under-redact.
 *
 * This does NOT replace `toUserMessage()` in api/errors.ts, which maps a
 * classified error to a short, friendly sentence. This function is a safety
 * net for the free-text `message` that ends up in `lastError`, in case that
 * text originated somewhere other than a classified ApiError (e.g. a thrown
 * plain Error, or a message that already contains technical detail).
 */
export function sanitizeErrorText(message: string): string {
  if (typeof message !== 'string' || message.length === 0) return message;

  let sanitized = message;

  // Device tokens: "medidev_" + hex/alnum.
  sanitized = sanitized.replace(/medidev_[a-zA-Z0-9_-]+/g, '[redacted-token]');
  // Bearer tokens and generic Authorization header values.
  sanitized = sanitized.replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [redacted]');
  sanitized = sanitized.replace(/Authorization:\s*\S+/gi, 'Authorization: [redacted]');
  // Cookie headers / Set-Cookie values.
  sanitized = sanitized.replace(/(Set-)?Cookie:\s*[^\n]+/gi, '$1Cookie: [redacted]');
  // Absolute filesystem paths (Unix-style; avoids leaking device/user paths in a crash message).
  sanitized = sanitized.replace(/\/(?:Users|home|var|private|Applications)\/[^\s'")]+/g, '[path redacted]');
  // Raw SQL keywords followed by identifiers, a defensive net in case a 500
  // ever echoes a query fragment.
  sanitized = sanitized.replace(/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[^.!?]{0,120}/gi, '[internal error]');
  // Long hex/base64-looking tokens (32+ chars) not already caught above.
  sanitized = sanitized.replace(/\b[a-f0-9]{32,}\b/gi, '[redacted]');

  return sanitized;
}

function emit(level: 'log' | 'warn' | 'error', scope: string, message: string, meta?: unknown): void {
  if (!config.debugLogging && level === 'log') return;
  const prefix = `[MediIndex:${scope}]`;
  if (meta === undefined) console[level](prefix, message);
  else console[level](prefix, message, redact(meta));
}

export const logger = {
  debug: (scope: string, message: string, meta?: unknown) => emit('log', scope, message, meta),
  warn: (scope: string, message: string, meta?: unknown) => emit('warn', scope, message, meta),
  error: (scope: string, message: string, meta?: unknown) => emit('error', scope, message, meta),
};
