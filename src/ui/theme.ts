// App-wide colours for everything outside the reading page (the page uses the
// reader themes in lib/settings).

import { useColorScheme } from 'react-native';

export interface AppColors {
  bg: string;
  card: string;
  elevated: string;
  text: string;
  secondary: string;
  border: string;
  accent: string;
  accentText: string;
  danger: string;
  chip: string;
  dark: boolean;
}

const LIGHT: AppColors = {
  bg: '#F6F5F2',
  card: '#FFFFFF',
  elevated: '#FFFFFF',
  text: '#1C1C1E',
  secondary: '#6E6E73',
  border: '#D8D5CE',
  accent: '#2F6FEB',
  accentText: '#FFFFFF',
  danger: '#D93025',
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
  accentText: '#FFFFFF',
  danger: '#FF6B5E',
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
