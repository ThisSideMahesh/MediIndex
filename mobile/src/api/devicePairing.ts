/**
 * Device pairing operations.
 *
 * Wraps the EXISTING MediIndex backend endpoint — nothing new is invented:
 *
 *   POST /api/mobile/pairing/complete   (no session auth; the pairing code IS
 *                                        the credential for this one call)
 *     body    { pairingCode, deviceName, deviceModel? }
 *     201     { success, deviceId, deviceName, deviceToken, pharmacy, pairedAt }
 *     400     { error: "<human message>" }
 *
 * The one-time pairing code is created by a pharmacy ADMIN in the web app via
 * POST /api/mobile/pairing/create. The mobile app never creates codes.
 *
 * Why the raw token never leaves this module: `pairDevice()` stores the token in
 * SecureStore and returns only the non-secret identity. A screen therefore has
 * no way to render, copy or log the token even by mistake.
 */

import { apiClient } from './client';
import { ApiError } from './errors';
import { API_ROUTES } from '../types/api';
import type { PairingCompleteRequest, PairingCompleteResponse } from '../types/api';
import { deviceCredentialStore, SecureStorageUnavailableError } from '../storage/secureStore';
import type { DeviceIdentity } from '../storage/secureStore';
import { logger } from '../utils/logger';

// ─── Pairing code shape ──────────────────────────────────────────────────────

/**
 * The server generates codes as `'MED-' + crypto.randomBytes(3).hex.toUpperCase()`
 * (core.js, POST /api/mobile/pairing/create) — always the literal prefix plus
 * exactly six uppercase hex characters. If that generator ever changes, this
 * pattern must change with it.
 */
export const PAIRING_CODE_PATTERN = /^MED-[0-9A-F]{6}$/;

/** Server-side length cap for the pairing code field. */
export const PAIRING_CODE_MAX_LENGTH = 50;
/** Server-side length cap for the device name field. */
export const DEVICE_NAME_MAX_LENGTH = 100;
/** Server-side length cap for the device model field. */
export const DEVICE_MODEL_MAX_LENGTH = 100;

/**
 * Canonicalises typed input: strips whitespace (including pasted line breaks)
 * and upper-cases. The server compares case-insensitively, so this only makes
 * local validation and display predictable.
 */
export function normalizePairingCode(raw: string): string {
  return (raw ?? '').replace(/\s+/g, '').toUpperCase();
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export type PairingFailureCode =
  /** Local validation */
  | 'PAIRING_CODE_REQUIRED'
  | 'PAIRING_CODE_MALFORMED'
  | 'DEVICE_NAME_REQUIRED'
  /** Server rejected the code (all four arrive as HTTP 400) */
  | 'PAIRING_CODE_INVALID'
  | 'PAIRING_CODE_USED'
  | 'PAIRING_CODE_EXPIRED'
  | 'PAIRING_CODE_CLAIMED'
  /** Transport / server / storage */
  | 'NETWORK'
  | 'TIMEOUT'
  | 'SERVER'
  | 'MALFORMED_RESPONSE'
  | 'STORAGE_UNAVAILABLE'
  | 'STORAGE_FAILED';

export class PairingError extends Error {
  readonly code: PairingFailureCode;
  /** True when the same code could plausibly work on another attempt. */
  readonly retryable: boolean;
  /** True when the user must obtain a brand-new pairing code from an admin. */
  readonly needsNewCode: boolean;

  constructor(code: PairingFailureCode, message: string) {
    super(message);
    this.name = 'PairingError';
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
    this.needsNewCode = NEEDS_NEW_CODE.has(code);
  }
}

const RETRYABLE_CODES: ReadonlySet<PairingFailureCode> = new Set([
  'NETWORK',
  'TIMEOUT',
  'SERVER',
  'MALFORMED_RESPONSE',
]);

const NEEDS_NEW_CODE: ReadonlySet<PairingFailureCode> = new Set([
  'PAIRING_CODE_INVALID',
  'PAIRING_CODE_USED',
  'PAIRING_CODE_EXPIRED',
  'PAIRING_CODE_CLAIMED',
]);

/**
 * The exact 400 messages the backend emits, mapped to a stable code and copy
 * that tells the user what to do next. Matched on the message because the
 * pairing endpoint returns `{ error }` without a machine-readable code.
 */
const SERVER_MESSAGE_MAP: ReadonlyArray<{
  match: RegExp;
  code: PairingFailureCode;
  message: string;
}> = [
  {
    match: /unrecognized pairing code/i,
    code: 'PAIRING_CODE_INVALID',
    message: 'That pairing code was not recognised. Check it for typos, or ask an administrator for a new one.',
  },
  {
    match: /already been used/i,
    code: 'PAIRING_CODE_USED',
    message: 'That pairing code has already been used. Ask an administrator to generate a new one.',
  },
  {
    match: /has expired/i,
    code: 'PAIRING_CODE_EXPIRED',
    message: 'That pairing code has expired. Codes are valid for 10 minutes — ask an administrator for a new one.',
  },
  {
    match: /already been claimed/i,
    code: 'PAIRING_CODE_CLAIMED',
    message: 'Another device claimed that pairing code first. Ask an administrator for a new one.',
  },
];

function mapApiError(error: ApiError): PairingError {
  if (error.kind === 'NETWORK') {
    return new PairingError('NETWORK', 'Could not reach the MediIndex server. Check the connection and try again.');
  }
  if (error.kind === 'TIMEOUT') {
    return new PairingError('TIMEOUT', 'The server took too long to respond. Try again.');
  }
  if (error.kind === 'MALFORMED') {
    return new PairingError('MALFORMED_RESPONSE', 'The server returned an unexpected response. Try again.');
  }

  const serverMessage = error.message ?? '';
  for (const entry of SERVER_MESSAGE_MAP) {
    if (entry.match.test(serverMessage)) return new PairingError(entry.code, entry.message);
  }

  if (typeof error.status === 'number' && error.status >= 500) {
    return new PairingError('SERVER', 'The MediIndex server is temporarily unavailable. Try again shortly.');
  }
  // Unmapped 4xx: surface the server's own wording rather than guessing.
  return new PairingError(
    'PAIRING_CODE_INVALID',
    serverMessage || 'Pairing failed. Check the code and try again.',
  );
}

// ─── Validation ──────────────────────────────────────────────────────────────

export interface PairDeviceInput {
  pairingCode: string;
  deviceName: string;
  deviceModel?: string;
}

/** Returns a user-facing problem with the pairing code, or null when valid. */
export function validatePairingCode(raw: string): PairingError | null {
  const code = normalizePairingCode(raw);
  if (!code) return new PairingError('PAIRING_CODE_REQUIRED', 'Enter the pairing code shown in MediIndex.');
  if (code.length > PAIRING_CODE_MAX_LENGTH) {
    return new PairingError('PAIRING_CODE_MALFORMED', 'That pairing code is too long.');
  }
  if (!PAIRING_CODE_PATTERN.test(code)) {
    return new PairingError(
      'PAIRING_CODE_MALFORMED',
      'Pairing codes look like MED-XXXXXX, using digits and the letters A to F.',
    );
  }
  return null;
}

/** Returns a user-facing problem with the device name, or null when valid. */
export function validateDeviceName(raw: string): PairingError | null {
  const name = (raw ?? '').trim();
  if (!name) return new PairingError('DEVICE_NAME_REQUIRED', 'Give this device a name so staff can identify it.');
  if (name.length > DEVICE_NAME_MAX_LENGTH) {
    return new PairingError(
      'DEVICE_NAME_REQUIRED',
      `Keep the device name to ${DEVICE_NAME_MAX_LENGTH} characters or fewer.`,
    );
  }
  return null;
}

/** Validates the whole form. Returns the first problem, or null when valid. */
export function validatePairDeviceInput(input: PairDeviceInput): PairingError | null {
  return validatePairingCode(input.pairingCode) ?? validateDeviceName(input.deviceName);
}

// ─── Response validation ─────────────────────────────────────────────────────

/**
 * Confirms the 201 body really is a pairing success carrying a usable token.
 * A malformed body must never be persisted, and must never be treated as paired.
 */
function readPairingResponse(body: unknown): PairingCompleteResponse {
  const raw = (body ?? {}) as Partial<PairingCompleteResponse> & Record<string, unknown>;
  const tokenOk = typeof raw.deviceToken === 'string' && raw.deviceToken.trim().length > 0;
  const idOk = typeof raw.deviceId === 'number' && Number.isFinite(raw.deviceId);
  const pharmacy = raw.pharmacy as { id?: unknown; name?: unknown; address?: unknown } | undefined;
  const pharmacyOk = !!pharmacy && typeof pharmacy.id === 'number' && typeof pharmacy.name === 'string';

  if (!tokenOk || !idOk || !pharmacyOk) {
    throw new PairingError(
      'MALFORMED_RESPONSE',
      'Pairing did not complete correctly. This device is still unpaired — please try again.',
    );
  }
  return raw as PairingCompleteResponse;
}

// ─── Operation ───────────────────────────────────────────────────────────────

/**
 * Exchanges a one-time pairing code for a device token, stores the token in
 * SecureStore, and returns the non-secret identity of the now-paired device.
 *
 * The returned value deliberately contains NO token.
 */
export async function pairDevice(input: PairDeviceInput): Promise<DeviceIdentity> {
  const invalid = validatePairDeviceInput(input);
  if (invalid) throw invalid;

  const body: PairingCompleteRequest = {
    // Normalised, never stored — the pairing code is not the device credential.
    pairingCode: normalizePairingCode(input.pairingCode),
    deviceName: input.deviceName.trim(),
  };
  const model = (input.deviceModel ?? '').trim();
  if (model) body.deviceModel = model.slice(0, DEVICE_MODEL_MAX_LENGTH);

  // Never log the pairing code or the response body.
  logger.debug('pairing', 'Submitting pairing request', { deviceName: body.deviceName });

  let response: PairingCompleteResponse;
  try {
    const raw = await apiClient.post<unknown>(API_ROUTES.pairingComplete, body, {
      // Unauthenticated by design: there is no device token yet.
      authenticated: false,
    });
    response = readPairingResponse(raw);
  } catch (err) {
    if (err instanceof PairingError) throw err;
    if (err instanceof ApiError) throw mapApiError(err);
    throw new PairingError('SERVER', 'Pairing failed unexpectedly. Please try again.');
  }

  try {
    await deviceCredentialStore.saveCredential({
      deviceToken: response.deviceToken,
      deviceId: response.deviceId,
      deviceName: response.deviceName ?? body.deviceName,
      pharmacyId: response.pharmacy.id,
      pharmacyName: response.pharmacy.name,
      pharmacyAddress: response.pharmacy.address ?? null,
      pairedAt: response.pairedAt ?? new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof SecureStorageUnavailableError) {
      throw new PairingError('STORAGE_UNAVAILABLE', err.message);
    }
    // The server issued a token we could not keep. Say so plainly: the pairing
    // code is now spent, so the user needs a fresh one.
    throw new PairingError(
      'STORAGE_FAILED',
      'Pairing succeeded on the server but the credential could not be saved on this device. Ask an administrator for a new pairing code and try again.',
    );
  }

  const identity: DeviceIdentity = {
    deviceId: response.deviceId,
    deviceName: response.deviceName ?? body.deviceName,
    pharmacyId: response.pharmacy.id,
    pharmacyName: response.pharmacy.name,
    pharmacyAddress: response.pharmacy.address ?? null,
    pairedAt: response.pairedAt ?? new Date().toISOString(),
  };
  logger.debug('pairing', 'Device paired', {
    deviceId: identity.deviceId,
    pharmacyId: identity.pharmacyId,
  });
  return identity;
}

/**
 * Removes this device's credential locally.
 *
 * LOCAL ONLY, and intentionally so: the backend's revoke operation
 * (POST /api/mobile/devices/:id/revoke) requires an ADMIN *web session*, not a
 * device token, so a paired device has no authenticated way to revoke itself.
 * No such endpoint is invented here. An administrator revokes the device
 * server-side from the MediIndex web app.
 */
export async function unpairDevice(): Promise<void> {
  await deviceCredentialStore.clearCredential();
  logger.debug('pairing', 'Device unpaired locally');
}

/** Non-secret paired state for the UI. Null when this device is unpaired. */
export async function getPairedIdentity(): Promise<DeviceIdentity | null> {
  return deviceCredentialStore.getIdentity();
}

/**
 * Clears the stored credential when the server says it is no longer valid —
 * an administrator revoked the device, or the token was rejected (401 /
 * DEVICE_REVOKED). Keeping a rejected token would leave the app retrying a
 * credential that can never succeed.
 *
 * Returns true when a credential was discarded, so a caller can route back to
 * Pair Device.
 *
 * Nothing invokes this yet: the app makes no authenticated request before stock
 * entry (Phase 7G). It lives here so the rule is implemented and tested once,
 * next to the credential lifecycle, rather than re-decided by each caller.
 */
export async function handleAuthFailure(error: unknown): Promise<boolean> {
  if (!(error instanceof ApiError) || !error.isAuthFailure) return false;
  logger.warn('pairing', 'Device credential was rejected by the server; clearing it');
  try {
    await deviceCredentialStore.clearCredential();
  } catch {
    // Reported, not rethrown: the caller's job is to re-pair, not to retry a delete.
    logger.warn('pairing', 'Could not clear the rejected device credential');
    return false;
  }
  return true;
}
