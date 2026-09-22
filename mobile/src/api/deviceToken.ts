/**
 * Binds the API client's token provider and auth failure handler to secure storage.
 *
 * The token provider supplies the current device token per request.
 * The auth failure handler clears invalid credentials from SecureStore.
 *
 * Both are wired once at app startup, before any authenticated request.
 */

import { apiClient } from './client';
import { deviceCredentialStore } from '../storage/secureStore';
import { logger } from '../utils/logger';

/**
 * Registers SecureStore as the source of the device token and sets up
 * centralized authentication failure handling. Idempotent.
 */
export function bindDeviceAuthentication(): void {
  // Token provider: per-request credential retrieval
  apiClient.setTokenProvider(() => deviceCredentialStore.getDeviceToken());

  // Auth failure handler: clear invalid credentials
  apiClient.setAuthFailureHandler(async (error) => {
    logger.warn('auth', 'Device credential was rejected by the server; clearing it');
    try {
      await deviceCredentialStore.clearCredential();
    } catch (clearErr) {
      logger.warn('auth', 'Could not clear the rejected device credential', { error: clearErr });
    }
  });
}

/** Removes the providers. Used by tests; not needed in normal app flow. */
export function unbindDeviceAuthentication(): void {
  apiClient.setTokenProvider(null);
  apiClient.setAuthFailureHandler(null);
}
