/**
 * Mobile authentication state management.
 *
 * The state model explicitly distinguishes:
 *  - UNPAIRED: no local credential exists
 *  - VERIFYING: local credential exists, server verification in progress
 *  - AUTHENTICATED: server confirmed the device is valid
 *  - AUTH_INVALID: server rejected the credential (401 / revoked)
 *  - AUTH_ERROR: network/server failure during verification
 *
 * The raw device token is never stored in this state. Authentication success
 * provides the non-secret device and pharmacy identity only.
 *
 * This is a React state container, not a global singleton — each component tree
 * (screen) that needs authentication state manages its own instance.
 */

export type AuthStatus = 'UNPAIRED' | 'VERIFYING' | 'AUTHENTICATED' | 'AUTH_INVALID' | 'AUTH_ERROR';

export interface DeviceIdentity {
  deviceId: number;
  deviceName: string;
  deviceModel: string | null;
  pharmacyId: number;
  pharmacyName: string;
  pharmacyAddress: string | null;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface AuthState {
  status: AuthStatus;
  /** Non-secret device/pharmacy identity when authenticated. */
  identity: DeviceIdentity | null;
  /** User-facing error when status is AUTH_ERROR. */
  error: string | null;
  /** True when a verification attempt is actively running. */
  isVerifying: boolean;
}

export const INITIAL_AUTH_STATE: AuthState = {
  status: 'UNPAIRED',
  identity: null,
  error: null,
  isVerifying: false,
};

export interface AuthStateActions {
  startVerification(): void;
  setAuthenticated(identity: DeviceIdentity): void;
  setAuthInvalid(): void;
  setAuthError(error: string): void;
  setUnpaired(): void;
}

/** Creates auth state reducer actions. */
export function createAuthActions(
  setState: React.Dispatch<React.SetStateAction<AuthState>>,
): AuthStateActions {
  return {
    startVerification: () =>
      setState((prev) => ({
        ...prev,
        status: 'VERIFYING',
        error: null,
        isVerifying: true,
      })),

    setAuthenticated: (identity: DeviceIdentity) =>
      setState({
        status: 'AUTHENTICATED',
        identity,
        error: null,
        isVerifying: false,
      }),

    setAuthInvalid: () =>
      setState({
        status: 'AUTH_INVALID',
        identity: null,
        error: null,
        isVerifying: false,
      }),

    setAuthError: (error: string) =>
      setState((prev) => ({
        ...prev,
        status: 'AUTH_ERROR',
        error,
        isVerifying: false,
      })),

    setUnpaired: () =>
      setState({
        status: 'UNPAIRED',
        identity: null,
        error: null,
        isVerifying: false,
      }),
  };
}