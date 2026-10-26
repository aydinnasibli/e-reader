// App-wide colours for everything outside the reading page (the page uses the
// reader themes in lib/settings). Text in them is at least 4.5:1 against what
// it's drawn on (WCAG AA; test/ui/theme.test.tsx checks the pairs used).

import { useColorScheme } from 'react-native';

export interface AppColors {
  bg: string;
  card: string;
  elevated: string;
  text: string;
  secondary: string;
  border: string;
  accent: string;
  /** Text on an accent-coloured button. */
  accentText: string;
  danger: string;
  /** Text on a danger-coloured badge. */
  dangerText: string;
  chip: string;
  dark: boolean;
}

const LIGHT: AppColors = {
  bg: '#F6F5F2',
  card: '#FFFFFF',
  elevated: '#FFFFFF',
  text: '#1C1C1E',
  secondary: '#66666B',
  border: '#D8D5CE',
  accent: '#2568EA',
  accentText: '#FFFFFF',
  danger: '#D52F24',
  dangerText: '#FFFFFF',
  chip: '#E8E5DE',
  dark: false,
};

const DARK: AppColors = {
  bg: '#111113',
  card: '#1C1C1F',
  elevated: '#26262B',
  text: '#F2F2F4',
  secondary: '#9E9EA4',
  border: '#3A3A40',
  accent: '#5B95FF',
  // Dark on these light fills: white on them is under 3:1.
  accentText: '#111113',
  danger: '#FF6B5E',
  dangerText: '#111113',
  chip: '#2A2A30',
  dark: true,
};

export function useAppColors(): AppColors {
  return useColorScheme() === 'dark' ? DARK : LIGHT;
}

export const HIGHLIGHT_COLORS = {
  yellow: { light: '#FFE58A', dark: '#7A6420' },
  green: { light: '#B6EBA8', dark: '#3E6B35' },
  blue: { light: '#B4D8FF', dark: '#2F5480' },
  pink: { light: '#FFC2D9', dark: '#7A3550' },
} as const;

export type HighlightColor = keyof typeof HIGHLIGHT_COLORS;

/** A highlight colour as drawn on a light or dark page. */
export function highlightColor(color: HighlightColor, dark: boolean): string {
  return HIGHLIGHT_COLORS[color][dark ? 'dark' : 'light'];
}
