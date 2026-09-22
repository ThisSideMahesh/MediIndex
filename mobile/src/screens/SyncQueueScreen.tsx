/**
 * Sync Queue Screen - Phase 7H Offline Queue Management + Phase 7I Sync Controls
 * 
 * Displays locally stored stock receipt operations and their sync state.
 * Provides visibility into pending, syncing, synced, and failed operations.
 * 
 * Phase 7I additions:
 *  - "Sync Now" triggers the coalescing sync engine (safe to tap repeatedly —
 *    duplicate taps join the same in-flight run, never start a second worker).
 *  - "Retry Failed" resets FAILED rows to PENDING (same key, same payload) and
 *    triggers a sync pass if online.
 *  - Status never claims success the server has not confirmed: SYNCED is only
 *    ever set by the sync engine after an authoritative server response.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';

import { theme } from '../components/theme';
import { logger, sanitizeErrorText } from '../utils/logger';
import { outbox, type OutboxRecord, type OutboxCounts } from '../storage/outbox';
import { syncEngine, isAuthFailureRecord, stripAuthFailurePrefix } from '../sync/syncEngine';

type Props = NativeStackScreenProps<RootStackParamList, 'SyncQueue'>;

interface SyncQueueState {
  loading: boolean;
  refreshing: boolean;
  records: OutboxRecord[];
  counts: OutboxCounts;
  error: string | null;
  /** True while a "Sync Now" or "Retry Failed" action is in flight, for button disabling only. */
  syncing: boolean;
}

export function SyncQueueScreen({ navigation }: Props) {
  const [state, setState] = useState<SyncQueueState>({
    loading: true,
    refreshing: false,
    records: [],
    counts: { pending: 0, syncing: 0, synced: 0, failed: 0 },
    error: null,
    syncing: false,
  });

  const loadData = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) {
        setState(prev => ({ ...prev, refreshing: true, error: null }));
      } else {
        setState(prev => ({ ...prev, loading: true, error: null }));
      }

      logger.debug('sync-queue', 'Loading outbox records');

      const [records, counts] = await Promise.all([
        outbox.listAll(),
        outbox.counts(),
      ]);

      logger.debug('sync-queue', 'Loaded outbox data', {
        recordCount: records.length,
        counts,
      });

      setState(prev => ({
        ...prev,
        loading: false,
        refreshing: false,
        records,
        counts,
        error: null,
      }));

    } catch (err) {
      logger.error('sync-queue', 'Failed to load outbox data', { error: err });
      
      const errorMessage = err instanceof Error ? err.message : 'Failed to load queue data';
      
      setState(prev => ({
        ...prev,
        loading: false,
        refreshing: false,
        error: errorMessage,
      }));
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Refresh handler for pull-to-refresh
  const handleRefresh = useCallback(() => {
    loadData(true);
  }, [loadData]);

  /**
   * "Sync Now" — always safe to tap, including repeatedly or while an automatic
   * sync triggered by startup/foreground/NetInfo is already running: syncEngine
   * coalesces all of these into a single worker. Opening this screen and tapping
   * this button never calls the backend by itself outside of this explicit action
   * (or an automatic trigger elsewhere) — merely viewing the queue does not sync.
   */
  const handleSyncNow = useCallback(async () => {
    setState(prev => ({ ...prev, syncing: true }));
    try {
      await syncEngine.syncNow();
    } catch (err) {
      logger.warn('sync-queue', 'Sync Now failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      setState(prev => ({ ...prev, syncing: false }));
      await loadData();
    }
  }, [loadData]);

  /**
   * "Retry Failed" — resets every FAILED row to PENDING (preserving idempotency
   * key and payload; only status/attempts/error metadata change) and triggers a
   * sync pass. Individual retry is also available per-row via retryOne().
   */
  const handleRetryAllFailed = useCallback(async () => {
    setState(prev => ({ ...prev, syncing: true }));
    try {
      const failed = state.records.filter(r => r.status === 'FAILED');
      for (const record of failed) {
        try {
          await syncEngine.retry(record.id);
        } catch (err) {
          logger.warn('sync-queue', 'Could not retry record', {
            id: record.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      setState(prev => ({ ...prev, syncing: false }));
      await loadData();
    }
  }, [state.records, loadData]);

  const retryOne = useCallback(async (id: string) => {
    setState(prev => ({ ...prev, syncing: true }));
    try {
      await syncEngine.retry(id);
    } catch (err) {
      logger.warn('sync-queue', 'Could not retry record', { id, error: err instanceof Error ? err.message : String(err) });
      Alert.alert('Retry failed', err instanceof Error ? err.message : 'Could not retry this operation.');
    } finally {
      setState(prev => ({ ...prev, syncing: false }));
      await loadData();
    }
  }, [loadData]);

  const formatDate = (isoString: string): string => {
    try {
      const date = new Date(isoString);
      return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return 'Invalid date';
    }
  };

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'PENDING': return '#FF9800'; // Orange
      case 'SYNCING': return '#2196F3'; // Blue
      case 'SYNCED': return '#4CAF50'; // Green
      case 'FAILED': return '#F44336'; // Red
      default: return theme.colors.muted;
    }
  };

  const getStatusIcon = (status: string): string => {
    switch (status) {
      case 'PENDING': return '⏳';
      case 'SYNCING': return '🔄';
      case 'SYNCED': return '✅';
      case 'FAILED': return '❌';
      default: return '❓';
    }
  };

  /**
   * Phase 7J requirement 12: clear, non-technical status copy distinct from
   * the raw status word. Never claims success ("Synced") for anything the
   * server has not actually confirmed — this reads the persisted status only.
   */
  const getStatusLabel = (record: OutboxRecord): string => {
    switch (record.status) {
      case 'PENDING': return 'Waiting for internet';
      case 'SYNCING': return 'Synchronizing…';
      case 'SYNCED': return 'Synced';
      case 'FAILED': return isAuthFailureRecord(record) ? 'Needs device re-pairing' : 'Needs attention';
      default: return record.status;
    }
  };

  const renderRecord = ({ item }: { item: OutboxRecord }) => {
    const statusColor = getStatusColor(item.status);
    const statusIcon = getStatusIcon(item.status);
    const statusLabel = getStatusLabel(item);
    const isAuthFailure = isAuthFailureRecord(item);

    return (
      <View style={styles.recordCard}>
        <View style={styles.recordHeader}>
          <View style={styles.statusBadge}>
            <Text style={styles.statusIcon}>{statusIcon}</Text>
            <Text style={[styles.statusText, { color: statusColor }]}>
              {statusLabel}
            </Text>
          </View>
          <Text style={styles.timestamp}>
            {formatDate(item.createdAt)}
          </Text>
        </View>

        <View style={styles.recordBody}>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Medicine ID:</Text>
            <Text style={styles.infoValue}>{item.medicineId}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Batch:</Text>
            <Text style={styles.infoValue}>{item.batchNumber}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Quantity:</Text>
            <Text style={styles.infoValue}>+{item.quantity} units</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Operation ID:</Text>
            <Text style={styles.infoValue}>
              {item.id.substring(0, 20)}...
            </Text>
          </View>
        </View>

        {item.status === 'FAILED' && (
          <View style={[styles.errorSection, isAuthFailure && styles.authErrorSection]}>
            {isAuthFailure ? (
              <>
                <Text style={styles.authErrorLabel}>🔒 Device authentication required</Text>
                <Text style={styles.errorText}>
                  This device&apos;s pairing is no longer valid. Re-pair the device in Settings, then retry —
                  the same receipt will be used, nothing will be duplicated.
                </Text>
              </>
            ) : (
              item.lastError && (
                <>
                  <Text style={styles.errorLabel}>Error:</Text>
                  {/* Defence in depth: sanitize again at render time even though the
                      engine already sanitizes before persisting (Phase 7J req 14). */}
                  <Text style={styles.errorText}>{sanitizeErrorText(stripAuthFailurePrefix(item.lastError))}</Text>
                </>
              )
            )}
            <Text style={styles.attemptsText}>
              Attempts: {item.attempts}
            </Text>
            <TouchableOpacity
              style={styles.retryRowButton}
              onPress={() => retryOne(item.id)}
              disabled={state.syncing}
              accessibilityRole="button"
              accessibilityLabel={`Retry stock receipt for medicine ${item.medicineId}, batch ${item.batchNumber}`}
            >
              <Text style={styles.retryRowButtonText}>Retry This Operation</Text>
            </TouchableOpacity>
          </View>
        )}

        {item.status === 'SYNCED' && item.syncedAt && (
          <View style={styles.syncedSection}>
            <Text style={styles.syncedText}>
              ✅ Synced: {formatDate(item.syncedAt)}
            </Text>
          </View>
        )}
      </View>
    );
  };

  const renderSummary = () => {
    const { counts } = state;
    const total = counts.pending + counts.syncing + counts.synced + counts.failed;

    if (total === 0) {
      return (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyTitle}>📋 Queue is Empty</Text>
          <Text style={styles.emptyText}>
            No stock receipt operations are currently queued.
          </Text>
          <Text style={styles.emptySubtext}>
            Offline stock receipts will appear here when you're disconnected.
          </Text>
        </View>
      );
    }

    return (
      <View style={styles.summaryContainer}>
        <Text style={styles.summaryTitle}>Queue Summary</Text>
        <View style={styles.summaryGrid}>
          <View style={[styles.summaryCard, styles.pendingCard]}>
            <Text style={styles.summaryCount}>{counts.pending}</Text>
            <Text style={styles.summaryLabel}>Pending</Text>
          </View>
          <View style={[styles.summaryCard, styles.syncingCard]}>
            <Text style={styles.summaryCount}>{counts.syncing}</Text>
            <Text style={styles.summaryLabel}>Syncing</Text>
          </View>
          <View style={[styles.summaryCard, styles.syncedCard]}>
            <Text style={styles.summaryCount}>{counts.synced}</Text>
            <Text style={styles.summaryLabel}>Synced</Text>
          </View>
          <View style={[styles.summaryCard, styles.failedCard]}>
            <Text style={styles.summaryCount}>{counts.failed}</Text>
            <Text style={styles.summaryLabel}>Failed</Text>
          </View>
        </View>
        {counts.pending > 0 && (
          <View style={styles.pendingNote}>
            <Text style={styles.pendingNoteText}>
              ⏳ {counts.pending} operation{counts.pending === 1 ? '' : 's'} waiting for internet connection
            </Text>
          </View>
        )}
      </View>
    );
  };

  const renderError = () => {
    if (!state.error) return null;

    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorTitle}>❌ Error Loading Queue</Text>
        <Text style={styles.errorMessage}>{state.error}</Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={() => loadData()}
        >
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  };

  if (state.loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color={theme.colors.accent} />
        <Text style={styles.loadingText}>Loading queue...</Text>
      </View>
    );
  }

  if (state.error) {
    return (
      <View style={styles.container}>
        {renderError()}
      </View>
    );
  }

  const hasFailed = state.counts.failed > 0;

  return (
    <View style={styles.container}>
      <FlatList
        data={state.records}
        renderItem={renderRecord}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={renderSummary}
        ListEmptyComponent={renderSummary}
        contentContainerStyle={state.records.length === 0 ? styles.emptyListContainer : undefined}
        refreshControl={
          <RefreshControl
            refreshing={state.refreshing}
            onRefresh={handleRefresh}
            colors={[theme.colors.accent]}
            tintColor={theme.colors.accent}
          />
        }
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />

      <View style={styles.actionBar}>
        <TouchableOpacity
          style={[styles.actionButton, styles.syncNowButton, state.syncing && styles.actionButtonDisabled]}
          onPress={handleSyncNow}
          disabled={state.syncing}
          accessibilityRole="button"
          accessibilityLabel="Sync now"
        >
          {state.syncing ? (
            <ActivityIndicator size="small" color={theme.colors.surface} />
          ) : (
            <Text style={styles.syncNowButtonText}>Sync Now</Text>
          )}
        </TouchableOpacity>

        {hasFailed && (
          <TouchableOpacity
            style={[styles.actionButton, styles.retryFailedButton, state.syncing && styles.actionButtonDisabled]}
            onPress={handleRetryAllFailed}
            disabled={state.syncing}
            accessibilityRole="button"
            accessibilityLabel="Retry all failed operations"
          >
            <Text style={styles.retryFailedButtonText}>Retry Failed ({state.counts.failed})</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: theme.spacing.lg,
  },
  loadingText: {
    marginTop: theme.spacing.md,
    fontSize: theme.font.body,
    color: theme.colors.muted,
    textAlign: 'center',
  },
  emptyListContainer: {
    flexGrow: 1,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: theme.spacing.xl,
  },
  emptyTitle: {
    fontSize: theme.font.title,
    fontWeight: '600',
    color: theme.colors.ink,
    textAlign: 'center',
    marginBottom: theme.spacing.md,
  },
  emptyText: {
    fontSize: theme.font.body,
    color: theme.colors.muted,
    textAlign: 'center',
    marginBottom: theme.spacing.sm,
    lineHeight: 22,
  },
  emptySubtext: {
    fontSize: theme.font.sm,
    color: theme.colors.muted,
    textAlign: 'center',
    fontStyle: 'italic',
  },
  summaryContainer: {
    padding: theme.spacing.lg,
    backgroundColor: theme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.line,
  },
  summaryTitle: {
    fontSize: theme.font.lg,
    fontWeight: '600',
    color: theme.colors.ink,
    marginBottom: theme.spacing.md,
  },
  summaryGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: theme.spacing.md,
  },
  summaryCard: {
    flex: 1,
    marginHorizontal: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    minHeight: 70,
    justifyContent: 'center',
  },
  pendingCard: {
    backgroundColor: '#FFF3E0',
    borderColor: '#FF9800',
    borderWidth: 1,
  },
  syncingCard: {
    backgroundColor: '#E3F2FD',
    borderColor: '#2196F3',
    borderWidth: 1,
  },
  syncedCard: {
    backgroundColor: '#E8F5E8',
    borderColor: '#4CAF50',
    borderWidth: 1,
  },
  failedCard: {
    backgroundColor: '#FFEBEE',
    borderColor: '#F44336',
    borderWidth: 1,
  },
  summaryCount: {
    fontSize: theme.font.title,
    fontWeight: '700',
    color: theme.colors.ink,
    marginBottom: theme.spacing.xs,
  },
  summaryLabel: {
    fontSize: theme.font.sm,
    color: theme.colors.muted,
    textAlign: 'center',
    textTransform: 'uppercase',
    fontWeight: '500',
  },
  pendingNote: {
    backgroundColor: '#FFF3E0',
    padding: theme.spacing.md,
    borderRadius: theme.radius.sm,
    borderLeftWidth: 4,
    borderLeftColor: '#FF9800',
  },
  pendingNoteText: {
    fontSize: theme.font.body,
    color: '#E65100',
    textAlign: 'center',
  },
  recordCard: {
    marginHorizontal: theme.spacing.lg,
    marginVertical: theme.spacing.sm,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.line,
  },
  recordHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing.md,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusIcon: {
    fontSize: 16,
    marginRight: theme.spacing.xs,
  },
  statusText: {
    fontSize: theme.font.body,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  timestamp: {
    fontSize: theme.font.sm,
    color: theme.colors.muted,
  },
  recordBody: {
    marginBottom: theme.spacing.sm,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing.xs,
  },
  infoLabel: {
    fontSize: theme.font.body,
    color: theme.colors.muted,
    flex: 1,
  },
  infoValue: {
    fontSize: theme.font.body,
    color: theme.colors.ink,
    fontWeight: '500',
    textAlign: 'right',
    flex: 1,
  },
  errorSection: {
    marginTop: theme.spacing.sm,
    padding: theme.spacing.sm,
    backgroundColor: '#FFEBEE',
    borderRadius: theme.radius.sm,
    borderLeftWidth: 4,
    borderLeftColor: '#F44336',
  },
  errorLabel: {
    fontSize: theme.font.sm,
    color: '#D32F2F',
    fontWeight: '600',
    marginBottom: theme.spacing.xs,
  },
  authErrorSection: {
    backgroundColor: '#FFF3E0',
    borderLeftColor: '#E65100',
  },
  authErrorLabel: {
    fontSize: theme.font.sm,
    color: '#E65100',
    fontWeight: '700',
    marginBottom: theme.spacing.xs,
  },
  errorText: {
    fontSize: theme.font.sm,
    color: '#D32F2F',
    marginBottom: theme.spacing.xs,
  },
  attemptsText: {
    fontSize: theme.font.sm,
    color: '#D32F2F',
    fontStyle: 'italic',
  },
  syncedSection: {
    marginTop: theme.spacing.sm,
    padding: theme.spacing.sm,
    backgroundColor: '#E8F5E8',
    borderRadius: theme.radius.sm,
    borderLeftWidth: 4,
    borderLeftColor: '#4CAF50',
  },
  syncedText: {
    fontSize: theme.font.sm,
    color: '#2E7D32',
    fontWeight: '500',
  },
  separator: {
    height: 1,
    backgroundColor: theme.colors.line,
    marginHorizontal: theme.spacing.lg,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: theme.spacing.xl,
  },
  errorTitle: {
    fontSize: theme.font.lg,
    fontWeight: '600',
    color: theme.colors.danger,
    textAlign: 'center',
    marginBottom: theme.spacing.md,
  },
  errorMessage: {
    fontSize: theme.font.body,
    color: theme.colors.danger,
    textAlign: 'center',
    marginBottom: theme.spacing.lg,
    lineHeight: 22,
  },
  retryButton: {
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.xl,
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.md,
  },
  retryButtonText: {
    fontSize: theme.font.body,
    fontWeight: '600',
    color: theme.colors.surface,
  },
  retryRowButton: {
    marginTop: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    backgroundColor: '#F44336',
    borderRadius: theme.radius.sm,
    alignSelf: 'flex-start',
  },
  retryRowButtonText: {
    fontSize: theme.font.sm,
    fontWeight: '600',
    color: '#ffffff',
  },
  actionBar: {
    flexDirection: 'row',
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderTopWidth: 1,
    borderTopColor: theme.colors.line,
  },
  actionButton: {
    flex: 1,
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  actionButtonDisabled: {
    opacity: 0.6,
  },
  syncNowButton: {
    backgroundColor: theme.colors.accent,
  },
  syncNowButtonText: {
    fontSize: theme.font.body,
    fontWeight: '600',
    color: theme.colors.surface,
  },
  retryFailedButton: {
    backgroundColor: '#F44336',
  },
  retryFailedButtonText: {
    fontSize: theme.font.body,
    fontWeight: '600',
    color: '#ffffff',
  },
});