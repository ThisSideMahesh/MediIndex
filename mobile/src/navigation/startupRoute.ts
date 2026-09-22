/**
 * Startup routing decision, kept as a pure function so it can be tested
 * directly and so the Splash screen holds no branching logic of its own.
 *
 * Rule (Phase 7C):
 *   a stored device credential exists  -> Home
 *   no stored device credential        -> Pair Device
 *
 * The check is deliberately LOCAL. A protected backend endpoint is never called
 * merely to discover whether this device is paired: that would make app start
 * depend on connectivity, and an offline start must still reach Home.
 *
 * Server-side validation of the token (GET /api/mobile/auth/verify) belongs to a
 * later phase and must not gate startup.
 */

import type { RootStackParamList } from './RootNavigator';
import { deviceCredentialStore } from '../storage/secureStore';

export type StartRoute = Extract<keyof RootStackParamList, 'Home' | 'PairDevice'>;

/** Maps stored-credential presence to the first real screen. */
export function resolveStartRoute(hasCredential: boolean): StartRoute {
  return hasCredential ? 'Home' : 'PairDevice';
}

/**
 * Reads secure storage and returns the route to open.
 *
 * Fails safe: if secure storage cannot be read, the device is treated as
 * unpaired and sent to Pair Device rather than into an authenticated screen.
 */
export async function determineStartRoute(): Promise<StartRoute> {
  let paired = false;
  try {
    paired = await deviceCredentialStore.hasCredential();
  } catch {
    paired = false;
  }
  return resolveStartRoute(paired);
}
