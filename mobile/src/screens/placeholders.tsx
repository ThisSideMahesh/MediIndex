/**
 * Screens whose behaviour is not implemented yet.
 *
 * Each one states plainly that it is unfinished and names the phase that will
 * build it, so the app can never be mistaken for a half-working feature.
 *
 * Splash, Pair Device and Settings are real screens and live in their own files.
 * Home is now real and lives in its own file (Phase 7E).
 * Scan QR is now real and lives in its own file (Phase 7F).
 * Stock Receipt is now real and lives in its own file (Phase 7G).
 */

import React from 'react';
import { PlaceholderScreen } from '../components/PlaceholderScreen';

export function SyncQueueScreen() {
  return (
    <PlaceholderScreen
      title="Sync Queue"
      phase="Phase 7H / 7I / 7J — offline queue, sync, retry"
      description="Will list locally stored receipts and their sync state, with retry for permanent failures."
      responsibilities={[
        'List receipts grouped by PENDING, SYNCING, SYNCED and FAILED',
        'Show attempt count and the last error for a failed receipt',
        'Allow a manual retry that reuses the same idempotency key',
        'Never imply a PENDING receipt has already updated server inventory',
      ]}
    />
  );
}
