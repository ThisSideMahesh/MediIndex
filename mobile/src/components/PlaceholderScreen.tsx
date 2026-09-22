/**
 * Shared placeholder body for screens whose behaviour arrives in a later phase.
 *
 * Every placeholder states plainly that the screen is not implemented yet and
 * which phase will build it, so the scaffold can never be mistaken for a
 * half-finished feature.
 */

import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { theme } from './theme';

export interface PlaceholderScreenProps {
  title: string;
  /** e.g. "Phase 7C — Device pairing" */
  phase: string;
  /** One or two sentences on what the screen will do. */
  description: string;
  /** Bullet list of the concrete responsibilities planned for the screen. */
  responsibilities?: string[];
}

export function PlaceholderScreen({ title, phase, description, responsibilities = [] }: PlaceholderScreenProps) {
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.badge}>
        <Text style={styles.badgeText}>NOT IMPLEMENTED YET</Text>
      </View>

      <Text style={styles.title}>{title}</Text>
      <Text style={styles.phase}>{phase}</Text>
      <Text style={styles.description}>{description}</Text>

      {responsibilities.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardHeading}>Planned responsibilities</Text>
          {responsibilities.map((item) => (
            <Text key={item} style={styles.bullet}>
              {'\u2022'}  {item}
            </Text>
          ))}
        </View>
      )}

      <Text style={styles.footnote}>
        Phase 7B provides the scaffold only. No pairing, scanning, stock submission,
        queueing or synchronisation is implemented.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: theme.colors.warningBg,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.pill,
    marginBottom: theme.spacing.sm,
  },
  badgeText: { color: theme.colors.warningText, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  title: { fontSize: theme.font.title, fontWeight: '700', color: theme.colors.ink },
  phase: { fontSize: theme.font.sm, fontWeight: '600', color: theme.colors.accentDark },
  description: { fontSize: theme.font.body, color: theme.colors.muted, lineHeight: 21, marginTop: theme.spacing.xs },
  card: {
    marginTop: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.line,
    borderWidth: 1,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  cardHeading: { fontSize: theme.font.sm, fontWeight: '700', color: theme.colors.ink, marginBottom: theme.spacing.xs },
  bullet: { fontSize: theme.font.sm, color: theme.colors.muted, lineHeight: 20 },
  footnote: { marginTop: theme.spacing.lg, fontSize: 12, color: theme.colors.muted, fontStyle: 'italic' },
});
