// Reader settings, persisted to settings.json, plus the colour themes.

import { File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { Appearance } from 'react-native';
import { readJson, writeJson } from './storage';

export type ThemeName = 'light' | 'sepia' | 'dark' | 'black';
export type ReadMode = 'page' | 'scroll';
export type FontFamily = 'serif' | 'sans';

export interface ReaderSettings {
  mode: ReadMode;
  theme: ThemeName;
  fontSize: number;
  lineSpacing: number;
  margin: number;
  font: FontFamily;
  justify: boolean;
  indent: boolean;
}

export interface Theme {
  bg: string;
  text: string;
  muted: string;
  chrome: string;
  border: string;
  accent: string;
  dark: boolean;
}

export const THEMES: Record<ThemeName, Theme> = {
  light: { bg: '#FFFFFF', text: '#1B1B1B', muted: '#8A8A8E', chrome: '#F7F7F7', border: '#E2E2E2', accent: '#2F6FEB', dark: false },
  sepia: { bg: '#F5EDDC', text: '#4A3B2A', muted: '#9C8B73', chrome: '#EDE3CD', border: '#DCCFB3', accent: '#A0522D', dark: false },
  dark: { bg: '#1E1E20', text: '#D8D8D8', muted: '#8E8E93', chrome: '#2A2A2D', border: '#3A3A3D', accent: '#6EA8FE', dark: true },
  black: { bg: '#000000', text: '#B9B9B9', muted: '#6E6E73', chrome: '#121212', border: '#262626', accent: '#6EA8FE', dark: true },
};

export const FONT_SIZES = [14, 15, 16, 17, 18, 19, 20, 22, 24, 26, 28, 32];
export const LINE_SPACINGS = [1.3, 1.5, 1.7];
export const MARGINS = [12, 20, 32];

const DEFAULTS: ReaderSettings = {
  mode: 'page',
  theme: Appearance.getColorScheme() === 'dark' ? 'dark' : 'light',
  fontSize: 19,
  lineSpacing: 1.5,
  margin: 20,
  font: 'serif',
  justify: true,
  indent: true,
};

const file = () => new File(Paths.document, 'settings.json');
let settings: ReaderSettings | null = null;
const listeners = new Set<() => void>();

function current(): ReaderSettings {
  if (!settings) settings = { ...DEFAULTS, ...(readJson<Partial<ReaderSettings>>(file()) ?? {}) };
  return settings;
}

export function useSettings(): ReaderSettings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    current,
  );
}

export function setSettings(patch: Partial<ReaderSettings>) {
  settings = { ...current(), ...patch };
  writeJson(file(), settings);
  listeners.forEach((l) => l());
}
