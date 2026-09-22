/**
 * Network connectivity utilities for Phase 7H offline detection.
 * 
 * Provides simple online/offline detection for deciding between:
 * - Phase 7G online submission (when connected)
 * - Phase 7H offline queuing (when disconnected)
 * 
 * Does NOT trigger automatic synchronization - that's Phase 7I.
 */

import NetInfo from '@react-native-community/netinfo';
import { logger } from './logger';

export interface ConnectivityState {
  isConnected: boolean;
  type: string | null;
}

/**
 * Get current connectivity state.
 * Returns a promise that resolves with the current connection status.
 */
export async function getConnectivityState(): Promise<ConnectivityState> {
  try {
    const netInfoState = await NetInfo.fetch();
    
    const isConnected = netInfoState.isConnected === true && 
                       netInfoState.isInternetReachable === true;
    
    const type = netInfoState.type || null;
    
    logger.debug('connectivity', 'Current connectivity state', {
      isConnected,
      type,
      isInternetReachable: netInfoState.isInternetReachable,
    });
    
    return {
      isConnected,
      type,
    };
  } catch (error) {
    logger.warn('connectivity', 'Failed to get connectivity state, assuming offline', {
      error: error instanceof Error ? error.message : String(error),
    });
    
    // Conservative: assume offline if we can't determine state
    return {
      isConnected: false,
      type: null,
    };
  }
}

/**
 * Subscribe to connectivity changes.
 * Returns an unsubscribe function.
 * 
 * Note: Phase 7H does NOT use this for automatic sync.
 * This is provided for Phase 7I when automatic sync is implemented.
 */
export function subscribeToConnectivity(
  callback: (state: ConnectivityState) => void
): () => void {
  logger.debug('connectivity', 'Subscribing to connectivity changes');
  
  const unsubscribe = NetInfo.addEventListener(netInfoState => {
    const isConnected = netInfoState.isConnected === true && 
                       netInfoState.isInternetReachable === true;
    
    const type = netInfoState.type || null;
    
    const state: ConnectivityState = {
      isConnected,
      type,
    };
    
    logger.debug('connectivity', 'Connectivity state changed', state);
    callback(state);
  });
  
  return () => {
    logger.debug('connectivity', 'Unsubscribing from connectivity changes');
    unsubscribe();
  };
}

/**
 * Simple helper to check if device is currently online.
 * Used by stock receipt screen to decide between online/offline flow.
 */
export async function isOnline(): Promise<boolean> {
  const state = await getConnectivityState();
  return state.isConnected;
}