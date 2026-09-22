/**
 * Minimal design tokens, aligned with the MediIndex web palette
 * (see public/styles.css) so the mobile app looks part of the same product.
 */

export const theme = {
  colors: {
    ink: '#102a43',
    muted: '#627d98',
    surface: '#ffffff',
    background: '#f8fafc',
    accent: '#0d9488',
    accentDark: '#0f766e',
    accentLight: '#ccfbf1',
    accentBg: '#ccfbf1',
    line: '#d9e2ec',
    danger: '#c2410c',
    dangerBg: '#fee2e2',
    success: '#166534',
    successBg: '#dcfce7',
    successText: '#166534',
    warningBg: '#ffedd5',
    warningText: '#9a3412',
  },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  radius: { sm: 8, md: 12, lg: 16, pill: 999 },
  font: { sm: 13, body: 15, lg: 18, title: 22 },
} as const;

export type Theme = typeof theme;
