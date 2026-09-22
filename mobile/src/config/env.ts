/**
 * Runtime configuration for the MediIndex mobile app.
 *
 * The backend base URL is NEVER hard-coded to a deployed environment. It is read
 * from an Expo public env var so each developer (and each build profile) can
 * point the app at whichever backend they are allowed to reach.
 *
 * Provide it in `mobile/.env` (git-ignored):
 *
 *   EXPO_PUBLIC_MOBILE_API_BASE_URL=http://192.168.1.10:3000
 *
 * Notes for developers:
 *  - Android emulators cannot reach `localhost` on the host machine. Use
 *    `http://10.0.2.2:3000` (AVD) or your machine's LAN IP for a physical device.
 *  - The MediIndex Vercel Preview currently sits behind Deployment Protection
 *    (SSO), which a mobile device cannot authenticate through. Point the app at a
 *    local server or an unprotected deployment. Do not attempt to bypass SSO.
 *  - Only `EXPO_PUBLIC_*` vars are inlined into the client bundle. Never put a
 *    secret here — everything in this file is readable in the shipped app.
 */

/** Sensible local-development default; overridden by the env var when present. */
const DEFAULT_API_BASE_URL = 'http://10.0.2.2:3000';

function readBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_MOBILE_API_BASE_URL;
  const raw = typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv.trim() : DEFAULT_API_BASE_URL;
  // Normalize: strip trailing slashes so path joining stays predictable.
  return raw.replace(/\/+$/, '');
}

export interface AppConfig {
  /** Backend origin, e.g. "http://10.0.2.2:3000". No trailing slash. */
  apiBaseUrl: string;
  /** Network timeout for a single request attempt, in milliseconds. */
  requestTimeoutMs: number;
  /** True when the value came from the environment rather than the fallback. */
  apiBaseUrlFromEnv: boolean;
  /** Enables verbose (secret-free) request logging. */
  debugLogging: boolean;
}

export const config: AppConfig = {
  apiBaseUrl: readBaseUrl(),
  requestTimeoutMs: 15000,
  apiBaseUrlFromEnv: Boolean(process.env.EXPO_PUBLIC_MOBILE_API_BASE_URL),
  // __DEV__ is injected by React Native; default to false if absent.
  debugLogging: typeof __DEV__ !== 'undefined' ? __DEV__ : false,
};

/** Joins a path onto the configured API origin. */
export function apiUrl(path: string): string {
  return `${config.apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}
