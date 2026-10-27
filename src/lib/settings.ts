// Reader settings: global for all books, saved to settings.json. Also the
// colour themes, including user-defined colours and automatic night mode.

import { File, Paths } from 'expo-file-system';
import { Appearance, PixelRatio, useColorScheme } from 'react-native';
import { HIGHLIGHT_COLORS, type HighlightColor } from '@/ui/theme';
import type { Weight } from './fonts';
import { isRecord } from './guards';
import { readJson, saveJson } from './storage';
import { createStore } from './store';

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
  /** Language to translate into, from versions that kept one for all books; '' = the phone's language. */
  translateTo: string;
  /** Language to translate into, by the language of the book ('' when not known): English books → Turkish, Turkish books → English. */
  translateTargets: Record<string, string>;
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
  light: { bg: '#FFFFFF', text: '#1B1B1B', muted: '#6E6E73', chrome: '#F2F2F7', border: '#D1D1D6', accent: '#2F6FEB', dark: false },
  paper: { bg: '#FAF7F0', text: '#2B2A27', muted: '#6E685E', chrome: '#EEE8DA', border: '#D5CCB8', accent: '#3A6FD8', dark: false },
  sepia: { bg: '#F5EDDC', text: '#4A3B2A', muted: '#715F49', chrome: '#EADCBF', border: '#CFBD98', accent: '#A0522D', dark: false },
  mint: { bg: '#E9F3EA', text: '#1F3324', muted: '#566B5B', chrome: '#DAE8DD', border: '#B7CEBD', accent: '#2E7D4F', dark: false },
  gray: { bg: '#3A3A3D', text: '#E6E6E6', muted: '#B6B6BA', chrome: '#48484C', border: '#606066', accent: '#7FB2FF', dark: true },
  night: { bg: '#0F1A2A', text: '#C9D3E0', muted: '#8696B0', chrome: '#1A2A40', border: '#2C4160', accent: '#6EA8FE', dark: true },
  dark: { bg: '#1E1E20', text: '#D8D8D8', muted: '#9C9CA1', chrome: '#2C2C2F', border: '#48484C', accent: '#6EA8FE', dark: true },
  black: { bg: '#000000', text: '#B9B9B9', muted: '#8A8A8F', chrome: '#1C1C1E', border: '#38383A', accent: '#6EA8FE', dark: true },
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
  translateTargets: {},
  screenAwake: '10',
  showClock: true,
};

const file = () => new File(Paths.document, 'settings.json');
let settings: ReaderSettings | null = null;
const store = createStore();

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

const THEME_NAMES = [...Object.keys(THEMES), 'custom'];
const CHOICES: Partial<Record<keyof ReaderSettings, readonly string[]>> = {
  mode: ['page', 'scroll'],
  theme: THEME_NAMES,
  nightTheme: THEME_NAMES,
  weight: ['regular', 'medium'],
  align: ['justify', 'left'],
  pageTurn: ['slide', 'fade', 'none'],
  rotation: ['auto', 'portrait', 'landscape'],
  highlightColor: Object.keys(HIGHLIGHT_COLORS),
  screenAwake: ['system', '2', '5', '10', 'always'],
};
const RANGES: Partial<Record<keyof ReaderSettings, { min: number; max: number }>> = {
  fontSize: FONT_SIZE,
  lineSpacing: LINE_SPACING,
  letterSpacing: LETTER_SPACING,
  paraSpacing: PARA_SPACING,
  margin: MARGIN,
  autoWpm: { min: 0, max: 2000 },
};
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** A language code as a translation target or source ("tr", "zh-CN"). */
const LANG_CODE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;

/** Translation targets by book language: only codes that look like language codes. */
function targets(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(v)) if ((from === '' || LANG_CODE.test(from)) && typeof to === 'string' && LANG_CODE.test(to)) out[from] = to;
  return out;
}

/**
 * Settings from disk, checked field by field: a damaged file, a value from
 * another version or a hand edit falls back to the default instead of
 * reaching the layout code (an unknown theme name would crash the reader).
 */
export function sanitizeSettings(raw: Partial<Record<keyof ReaderSettings, unknown>>, defaults: ReaderSettings = DEFAULTS): ReaderSettings {
  const out = { ...defaults } as Record<keyof ReaderSettings, unknown>;
  for (const key of Object.keys(defaults) as (keyof ReaderSettings)[]) {
    const v = raw[key];
    const d = defaults[key];
    if (v === undefined || typeof v !== typeof d) continue;
    if (key === 'translateTargets') {
      const t = targets(v);
      if (t) out[key] = t;
    } else if (typeof v === 'number') {
      const r = RANGES[key];
      if (!Number.isFinite(v)) continue;
      out[key] = r ? Math.min(r.max, Math.max(r.min, v)) : v;
    } else if (typeof v === 'string') {
      const allowed = CHOICES[key];
      if (allowed && !allowed.includes(v)) continue;
      if ((key === 'customBg' || key === 'customText') && !COLOR.test(v)) continue;
      out[key] = v;
    } else out[key] = v;
  }
  return out as unknown as ReaderSettings;
}

/** First run: the book text starts as large as the phone's own text size setting asks. */
export function firstRunFontSize(scale: number): number {
  return Math.round(Math.min(FONT_SIZE.max, Math.max(DEFAULTS.fontSize, DEFAULTS.fontSize * (Number.isFinite(scale) ? scale : 1))));
}

function current(): ReaderSettings {
  if (!settings) {
    const saved = readJson<Record<string, unknown>>(file(), isRecord);
    // First run: start in a dark theme if the phone is in dark mode, at the phone's text size.
    const first: ReaderSettings = saved
      ? DEFAULTS
      : { ...DEFAULTS, theme: Appearance.getColorScheme() === 'dark' ? 'dark' : 'light', fontSize: firstRunFontSize(PixelRatio.getFontScale()) };
    settings = saved && typeof saved === 'object' ? sanitizeSettings(migrate(saved), first) : first;
  }
  return settings;
}

export function getSettings(): ReaderSettings {
  return current();
}

export function useSettings(): ReaderSettings {
  return store.useValue(current);
}

export function setSettings(patch: Partial<ReaderSettings>) {
  settings = { ...current(), ...patch };
  saveJson(file(), settings);
  store.notify();
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
    muted: mix(text, bg, 0.38),
    chrome: mix(bg, text, 0.07),
    border: mix(bg, text, 0.2),
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
