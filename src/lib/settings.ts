// Reader settings: global for all books, saved to settings.json. Also the
// colour themes, including user-defined colours and automatic night mode.

import { File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { Appearance, useColorScheme } from 'react-native';
import type { HighlightColor } from '@/ui/theme';
import type { Weight } from './fonts';
import { readJson, saveJson } from './storage';

export type ThemeName = 'light' | 'paper' | 'sepia' | 'mint' | 'gray' | 'night' | 'dark' | 'black' | 'custom';
export type ReadMode = 'page' | 'scroll';
export type PageTurn = 'slide' | 'fade' | 'none';
/** How long the screen stays on while reading without turning a page: minutes, 'always', or the phone's own setting. */
export type ScreenAwake = 'system' | '2' | '5' | '10' | 'always';

export interface ReaderSettings {
  mode: ReadMode;
  theme: ThemeName;
  customBg: string;
  customText: string;
  /** Follow the phone's dark mode by switching to `nightTheme`. */
  autoNight: boolean;
  nightTheme: ThemeName;
  font: string;
  weight: Weight;
  fontSize: number;
  lineSpacing: number;
  /** Extra space between letters, in points. */
  letterSpacing: number;
  /** Space between paragraphs, in lines. */
  paraSpacing: number;
  margin: number;
  align: 'justify' | 'left';
  indent: boolean;
  /** Break long words at syllables (soft hyphens). */
  hyphenate: boolean;
  pageTurn: PageTurn;
  /** Tapping either side goes forward (swipe to go back). */
  tapForward: boolean;
  /** Screen rotation while reading. Landscape shows two pages side by side. */
  rotation: 'auto' | 'portrait' | 'landscape';
  /** Colour the highlight tool uses (the last one picked). */
  highlightColor: HighlightColor;
  /** The tap-zone guide has been shown. */
  seenTapZones: boolean;
  /** Auto page turn / auto-scroll speed in words per minute; 0 = the reader's measured speed. */
  autoWpm: number;
  screenAwake: ScreenAwake;
  /** The time and battery level at the top of the page while reading. */
  showClock: boolean;
  /** Language to translate into; '' = the phone's language. */
  translateTo: string;
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

export const THEMES: Record<Exclude<ThemeName, 'custom'>, Theme> = {
  light: { bg: '#FFFFFF', text: '#1B1B1B', muted: '#8A8A8E', chrome: '#F7F7F7', border: '#E2E2E2', accent: '#2F6FEB', dark: false },
  paper: { bg: '#FAF7F0', text: '#2B2A27', muted: '#948F84', chrome: '#F2EEE4', border: '#E1DBCD', accent: '#3A6FD8', dark: false },
  sepia: { bg: '#F5EDDC', text: '#4A3B2A', muted: '#9C8B73', chrome: '#EDE3CD', border: '#DCCFB3', accent: '#A0522D', dark: false },
  mint: { bg: '#E9F3EA', text: '#1F3324', muted: '#7E9584', chrome: '#DFEBE1', border: '#C9DCCD', accent: '#2E7D4F', dark: false },
  gray: { bg: '#3A3A3D', text: '#E6E6E6', muted: '#A0A0A5', chrome: '#444448', border: '#525257', accent: '#7FB2FF', dark: true },
  night: { bg: '#0F1A2A', text: '#C9D3E0', muted: '#71819A', chrome: '#162336', border: '#22324A', accent: '#6EA8FE', dark: true },
  dark: { bg: '#1E1E20', text: '#D8D8D8', muted: '#8E8E93', chrome: '#2A2A2D', border: '#3A3A3D', accent: '#6EA8FE', dark: true },
  black: { bg: '#000000', text: '#B9B9B9', muted: '#6E6E73', chrome: '#121212', border: '#262626', accent: '#6EA8FE', dark: true },
};

export const BG_SWATCHES = ['#FFFFFF', '#FAF7F0', '#F5EDDC', '#EFE6D2', '#E9F3EA', '#E6EEF7', '#F3E8EE', '#3A3A3D', '#2B2B2E', '#0F1A2A', '#1E2A22', '#000000'];
export const TEXT_SWATCHES = ['#000000', '#1B1B1B', '#333333', '#4A3B2A', '#1F3324', '#1E2B44', '#B9B9B9', '#D8D8D8', '#E8E2D0', '#C9D3E0', '#FFFFFF', '#F2C88A'];

export const FONT_SIZE = { min: 12, max: 40 };
export const LINE_SPACING = { min: 1.0, max: 2.4 };
export const LETTER_SPACING = { min: -0.5, max: 3 };
export const PARA_SPACING = { min: 0, max: 1.5 };
export const MARGIN = { min: 8, max: 56 };

const DEFAULTS: ReaderSettings = {
  mode: 'page',
  theme: 'light',
  customBg: '#FAF7F0',
  customText: '#2B2A27',
  autoNight: true,
  nightTheme: 'dark',
  font: 'serif',
  weight: 'regular',
  fontSize: 19,
  lineSpacing: 1.5,
  letterSpacing: 0,
  paraSpacing: 0,
  margin: 20,
  align: 'justify',
  indent: true,
  hyphenate: true,
  pageTurn: 'slide',
  tapForward: false,
  rotation: 'auto',
  highlightColor: 'yellow',
  seenTapZones: false,
  autoWpm: 0,
  translateTo: '',
  screenAwake: '10',
  showClock: true,
};

const file = () => new File(Paths.document, 'settings.json');
let settings: ReaderSettings | null = null;
const listeners = new Set<() => void>();

/** Bring settings saved by older versions up to date. */
function migrate(raw: Record<string, unknown>): Partial<ReaderSettings> {
  const s = { ...raw } as Partial<ReaderSettings> & { justify?: boolean };
  if (typeof s.justify === 'boolean' && !s.align) s.align = s.justify ? 'justify' : 'left';
  delete s.justify;
  delete (s as { volumeKeys?: boolean }).volumeKeys;
  // Older versions added half a line between paragraphs when indent was off.
  if (s.paraSpacing === undefined && s.indent === false) s.paraSpacing = 0.5;
  return s;
}

function current(): ReaderSettings {
  if (!settings) {
    const saved = readJson<Record<string, unknown>>(file());
    // First run: start in a dark theme if the phone is in dark mode.
    const first = saved ? {} : { theme: (Appearance.getColorScheme() === 'dark' ? 'dark' : 'light') as ThemeName };
    settings = { ...DEFAULTS, ...first, ...(saved ? migrate(saved) : {}) };
  }
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
  saveJson(file(), settings);
  listeners.forEach((l) => l());
}

/** Reset text and spacing (not colours or page options). */
export function resetSettings() {
  const { font, weight, fontSize, lineSpacing, letterSpacing, paraSpacing, margin, align, indent, hyphenate } = DEFAULTS;
  setSettings({ font, weight, fontSize, lineSpacing, letterSpacing, paraSpacing, margin, align, indent, hyphenate });
}

// ---------- colours ----------

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
}

export function isDarkColor(hex: string) {
  const [r, g, b] = rgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

export function customTheme(bg: string, text: string): Theme {
  const dark = isDarkColor(bg);
  return {
    bg,
    text,
    muted: mix(text, bg, 0.45),
    chrome: mix(bg, text, 0.05),
    border: mix(bg, text, 0.15),
    accent: dark ? '#6EA8FE' : '#2F6FEB',
    dark,
  };
}

export function themeOf(name: ThemeName, s: ReaderSettings): Theme {
  return name === 'custom' ? customTheme(s.customBg, s.customText) : THEMES[name];
}

/** The theme to draw with now, honouring automatic night mode. */
export function useReaderTheme(s: ReaderSettings): Theme {
  const scheme = useColorScheme();
  const name = s.autoNight && scheme === 'dark' && !themeOf(s.theme, s).dark ? s.nightTheme : s.theme;
  return themeOf(name, s);
}
