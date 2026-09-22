/**
 * MediIndex mobile app entry point.
 *
 * Mounts safe-area + navigation, and binds the API client's device-token source
 * to secure storage before anything can issue a request.
 *
 * Phase 7H: Initializes SQLite outbox for offline stock receipts.
 */

import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RootNavigator } from './src/navigation/RootNavigator';
import { bindDeviceAuthentication } from './src/api/deviceToken';
import { outbox } from './src/storage/outbox';
import { syncEngine } from './src/sync/syncEngine';
import { config } from './src/config/env';
import { logger } from './src/utils/logger';

// Bound at module scope, so it is in place before the first render and therefore
// before any screen can trigger an authenticated request.
bindDeviceAuthentication();

export default function App() {
  React.useEffect(() => {
    // Initialize app services
    const initializeApp = async () => {
      try {
        // Non-secret startup diagnostics. The device token is never logged.
        logger.debug('app', 'MediIndex mobile app starting', {
          apiBaseUrl: config.apiBaseUrl,
          apiBaseUrlFromEnv: config.apiBaseUrlFromEnv,
        });

        // Initialize SQLite outbox database
        logger.debug('app', 'Initializing outbox database');
        await outbox.init();
        logger.debug('app', 'Outbox database initialized');

        // Phase 7I: start the sync engine. This triggers one coalesced sync
        // attempt now (if online) and subscribes to NetInfo online-transition
        // and app-foreground events for future automatic attempts. It does not
        // block startup — syncNow() runs asynchronously.
        logger.debug('app', 'Starting sync engine');
        await syncEngine.start();

        logger.debug('app', 'MediIndex mobile app started successfully');
      } catch (error) {
        logger.error('app', 'Failed to initialize app', { 
          error: error instanceof Error ? error.message : String(error) 
        });
        // Continue anyway - app should not fail to start due to outbox issues
      }
    };

    initializeApp();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <RootNavigator />
    </SafeAreaProvider>
  );
}
