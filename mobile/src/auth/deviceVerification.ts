/**
 * Server-authoritative device verification.
 *
 * Uses the existing `GET /api/mobile/auth/verify` endpoint to confirm that a
 * locally stored device credential is still valid on the server. The server
 * remains authoritative — a local credential may be invalid/revoked even if
 * SecureStore contains it.
 *
 * Authentication failures automatically clear the credential from SecureStore,
 * so an invalid token cannot be retried indefinitely.
 */

import { apiClient } from '../api/client';
import { ApiError } from '../api/errors';
import { API_ROUTES } from '../types/api';
import type { DeviceVerifyResponse } from '../types/api';
import { deviceCredentialStore } from '../storage/secureStore';
import type { DeviceIdentity } from './authState';
import { logger } from '../utils/logger';

export type VerifyResult =
  | { success: true; identity: DeviceIdentity }
  | { success: false; reason: 'no_credential' | 'auth_invalid' | 'network_error'; error?: string };

/**
 * Verifies the stored device credential against the server.
 *
 * Returns the device/pharmacy identity on success, or a structured failure
 * reason. Authentication failures clear the credential from SecureStore.
 */
export async function verifyStoredDevice(): Promise<VerifyResult> {
  // 1. Check if a credential exists locally
  const hasCredential = await deviceCredentialStore.hasCredential();
  if (!hasCredential) {
    return { success: false, reason: 'no_credential' };
  }

  // 2. Call the server verification endpoint
  let response: DeviceVerifyResponse;
  try {
    response = await apiClient.get<DeviceVerifyResponse>(API_ROUTES.deviceVerify, {
      authenticated: true,
    });
  } catch (err) {
    if (err instanceof ApiError && err.isAuthFailure) {
      // Invalid/revoked device: clear the credential so it's not retried
      logger.warn('auth', 'Device credential was rejected by the server; clearing it');
      try {
        await deviceCredentialStore.clearCredential();
      } catch {
        logger.warn('auth', 'Could not clear the rejected device credential');
      }
      return {
        success: false,
        reason: 'auth_invalid',
        error: 'This device is no longer authorized. Please pair it again.',
      };
    }

    // Network or server error: keep the credential, show error
    const message =
      err instanceof ApiError
        ? err.message
        : 'Could not verify this device. Check the connection and try again.';
    return { success: false, reason: 'network_error', error: message };
  }

  // 3. Server confirmed the device is valid
  const identity: DeviceIdentity = {
    deviceId: response.device.id,
    deviceName: response.device.name,
    deviceModel: response.device.model,
    pharmacyId: response.pharmacy.id,
    pharmacyName: response.pharmacy.name,
    pharmacyAddress: response.pharmacy.address,
    createdAt: response.device.createdAt,
    lastSeenAt: response.device.lastSeenAt,
  };

  logger.debug('auth', 'Device verification successful', {
    deviceId: identity.deviceId,
    pharmacyId: identity.pharmacyId,
  });
  return { success: true, identity };
}

/**
 * Determines the target route after device verification.
 * 
 * Used by SplashScreen to implement server-authoritative startup routing.
 */
export function resolveAuthenticatedRoute(result: VerifyResult): 'Home' | 'PairDevice' {
  return result.success ? 'Home' : 'PairDevice';
}