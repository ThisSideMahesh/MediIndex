/**
 * Device credential storage — the ONLY place the MediIndex device token lives.
 *
 * Backed by `expo-secure-store`, which on Android is the hardware-backed
 * Keystore and on iOS is the Keychain. There is no fallback: if secure storage
 * is unavailable the app refuses to pair rather than degrade to plaintext.
 *
 * Non-negotiable rules enforced here:
 *  - The device token is written to SecureStore and nowhere else. Never
 *    AsyncStorage, never SQLite, never a plain file, never source code.
 *  - The token is never logged. Callers receive it only through
 *    `getDeviceToken()`, which is wired into the API client's token provider.
 *  - The token is issued exactly once, by POST /api/mobile/pairing/complete.
 *    It is never generated locally and never derived from the pairing code.
 *  - Token and identity are stored as one atomic record, so there is no
 *    half-paired state where a token exists without knowing its pharmacy.
 *  - On unpair, or a 401 / DEVICE_REVOKED, the record is deleted outright.
 *
 * IMPORTANT — two different credentials:
 *   pairing code  : short-lived, single-use, entered by a human, NEVER stored
 *   device token  : long-lived, server-issued, stored here
 * `saveCredential()` only ever receives a server-issued device token.
 */

import * as SecureStore from 'expo-secure-store';
import { logger } from '../utils/logger';

/**
 * SecureStore keys may only contain alphanumerics, ".", "-" and "_".
 * Versioned so a future format change can be migrated rather than mis-read.
 */
const CREDENTIAL_KEY = 'mediindex.device.credential.v1';

/** Prefix the backend uses for device tokens (`'medidev_' + 32 random bytes`). */
const DEVICE_TOKEN_PREFIX = 'medidev_';

/** Non-secret half of the record — safe to display in the UI. */
export interface DeviceIdentity {
  deviceId: number;
  deviceName: string;
  pharmacyId: number;
  pharmacyName: string;
  pharmacyAddress: string | null;
  /** ISO timestamp returned by the server when pairing completed. */
  pairedAt: string;
}

/** The full stored record: identity plus the secret token. */
export interface DeviceCredential extends DeviceIdentity {
  /** Server-issued device token. Sent as the X-Device-Token header. */
  deviceToken: string;
}

/** Thrown when secure storage itself is unusable. Never swallowed silently. */
export class SecureStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecureStorageUnavailableError';
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validates a record read back from storage, or one about to be written.
 * Returns null when the shape is not a usable credential.
 */
function parseCredential(value: unknown): DeviceCredential | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;

  if (!isNonEmptyString(raw.deviceToken)) return null;
  if (typeof raw.deviceId !== 'number' || !Number.isFinite(raw.deviceId)) return null;
  if (!isNonEmptyString(raw.deviceName)) return null;
  if (typeof raw.pharmacyId !== 'number' || !Number.isFinite(raw.pharmacyId)) return null;
  if (!isNonEmptyString(raw.pharmacyName)) return null;

  return {
    deviceToken: raw.deviceToken.trim(),
    deviceId: raw.deviceId,
    deviceName: raw.deviceName,
    pharmacyId: raw.pharmacyId,
    pharmacyName: raw.pharmacyName,
    pharmacyAddress: isNonEmptyString(raw.pharmacyAddress) ? raw.pharmacyAddress : null,
    pairedAt: isNonEmptyString(raw.pairedAt) ? raw.pairedAt : new Date().toISOString(),
  };
}

/**
 * Confirms SecureStore is actually available before we rely on it.
 * `isAvailableAsync()` is false on web and on a device without a keystore.
 */
async function assertAvailable(): Promise<void> {
  let available = false;
  try {
    available = await SecureStore.isAvailableAsync();
  } catch {
    available = false;
  }
  if (!available) {
    throw new SecureStorageUnavailableError(
      'Secure storage is not available on this device, so MediIndex cannot store the device credential safely.',
    );
  }
}

/**
 * Persists the credential issued by POST /api/mobile/pairing/complete.
 *
 * Rejects anything that is not a plausible server-issued device token, which is
 * what stops a pairing code — or any locally invented value — from ever being
 * stored as the long-term device credential.
 */
async function saveCredential(credential: DeviceCredential): Promise<void> {
  const validated = parseCredential(credential);
  if (!validated) {
    throw new Error('Refusing to store an incomplete device credential.');
  }
  if (!validated.deviceToken.startsWith(DEVICE_TOKEN_PREFIX)) {
    // A pairing code ("MED-XXXXXX") or any other value fails here by design.
    throw new Error('Refusing to store a value that is not a server-issued device token.');
  }

  await assertAvailable();
  await SecureStore.setItemAsync(CREDENTIAL_KEY, JSON.stringify(validated), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  // Non-secret confirmation only. The token is never logged.
  logger.debug('storage', 'Device credential stored', {
    deviceId: validated.deviceId,
    pharmacyId: validated.pharmacyId,
  });
}

/** Reads the full credential, or null when this device is not paired. */
async function getCredential(): Promise<DeviceCredential | null> {
  let stored: string | null = null;
  try {
    stored = await SecureStore.getItemAsync(CREDENTIAL_KEY);
  } catch (err) {
    logger.warn('storage', 'Could not read the device credential from secure storage');
    return null;
  }
  if (!stored) return null;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(stored);
  } catch {
    parsed = null;
  }

  const credential = parseCredential(parsed);
  if (!credential) {
    // Corrupt or truncated record: remove it so the app re-pairs cleanly rather
    // than retrying an unusable credential forever. A failed cleanup must not
    // turn a read into a throw — the answer is still "not paired".
    logger.warn('storage', 'Stored device credential was unreadable; clearing it');
    try {
      await clearCredential();
    } catch {
      logger.warn('storage', 'Could not clear the unreadable device credential');
    }
    return null;
  }
  return credential;
}

/** Returns the raw device token for the API client, or null when unpaired. */
async function getDeviceToken(): Promise<string | null> {
  const credential = await getCredential();
  return credential ? credential.deviceToken : null;
}

/** Returns the non-secret identity for display. Never includes the token. */
async function getIdentity(): Promise<DeviceIdentity | null> {
  const credential = await getCredential();
  if (!credential) return null;
  const { deviceToken: _omitted, ...identity } = credential;
  return identity;
}

/**
 * True when a usable credential is stored.
 *
 * Purely local: startup routing must not call a protected backend endpoint just
 * to discover whether this device has been paired.
 */
async function hasCredential(): Promise<boolean> {
  return (await getCredential()) !== null;
}

/**
 * Deletes the stored credential. Used by unpair and by a revoked-device 401.
 *
 * Deliberately local-only. The server-side revoke endpoint
 * (POST /api/mobile/devices/:id/revoke) is authenticated as an ADMIN *session*,
 * not as a device, so a paired device cannot legitimately call it. Revoking
 * server-side is done by an administrator in the MediIndex web app.
 */
async function clearCredential(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(CREDENTIAL_KEY);
    logger.debug('storage', 'Device credential cleared');
  } catch (err) {
    logger.warn('storage', 'Could not clear the device credential');
    throw new Error('Could not remove the stored device credential from this device.');
  }
}

export interface DeviceCredentialStore {
  saveCredential(credential: DeviceCredential): Promise<void>;
  getCredential(): Promise<DeviceCredential | null>;
  getDeviceToken(): Promise<string | null>;
  getIdentity(): Promise<DeviceIdentity | null>;
  hasCredential(): Promise<boolean>;
  clearCredential(): Promise<void>;
}

export const deviceCredentialStore: DeviceCredentialStore = {
  saveCredential,
  getCredential,
  getDeviceToken,
  getIdentity,
  hasCredential,
  clearCredential,
};

/** Exported for tests and diagnostics. Not a secret — it is only a key name. */
export const DEVICE_CREDENTIAL_KEY = CREDENTIAL_KEY;

/** True now that Phase 7C has implemented real secure credential storage. */
export const SECURE_STORE_IMPLEMENTED = true;
