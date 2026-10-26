// Settings read from disk can't crash the reader: every field is checked.

import { expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Appearance: { getColorScheme: () => 'light' }, PixelRatio: { getFontScale: () => 1 }, useColorScheme: () => 'light' }));
vi.mock('expo-file-system', () => ({ File: class {}, Paths: { document: '' } }));
vi.mock('@/lib/storage', () => ({ readJson: () => null, saveJson: () => true }));

it('keeps good values, drops bad ones, clamps numbers', async () => {
  const { sanitizeSettings, themeOf, FONT_SIZE } = await import('../src/lib/settings');
  const s = sanitizeSettings({
    theme: 'neon' as never, // a theme from another version
    nightTheme: 'black',
    fontSize: 400,
    lineSpacing: Number.NaN,
    margin: '20' as never,
    customBg: 'url(javascript:alert(1))',
    customText: '#ABC',
    mode: 'scroll',
    hyphenate: 'yes' as never,
    highlightColor: 'purple' as never,
  });
  expect(s.theme).toBe('light');
  expect(s.nightTheme).toBe('black');
  expect(s.fontSize).toBe(FONT_SIZE.max);
  expect(s.lineSpacing).toBe(1.5);
  expect(s.margin).toBe(20);
  expect(s.customBg).toBe('#FAF7F0');
  expect(s.customText).toBe('#ABC');
  expect(s.mode).toBe('scroll');
  expect(s.hyphenate).toBe(true);
  expect(s.highlightColor).toBe('yellow');
  // What used to crash: drawing with a theme that doesn't exist.
  expect(themeOf(s.theme, s).bg).toBeTruthy();
});

it('first run: book text follows the phone text size, within the slider range', async () => {
  const { firstRunFontSize, FONT_SIZE } = await import('../src/lib/settings');
  expect(firstRunFontSize(1)).toBe(19);
  expect(firstRunFontSize(0.85)).toBe(19); // never smaller than the default
  expect(firstRunFontSize(1.35)).toBe(26);
  expect(firstRunFontSize(3.1)).toBe(FONT_SIZE.max);
  expect(firstRunFontSize(Number.NaN)).toBe(19);
});

it('translation targets by book language: only language codes are kept', async () => {
  const { sanitizeSettings } = await import('../src/lib/settings');
  const s = sanitizeSettings({ translateTargets: { en: 'tr', tr: 'en', '': 'az', xx: '<script>', '../x': 'en' } as never });
  expect(s.translateTargets).toEqual({ en: 'tr', tr: 'en', '': 'az' });
  expect(sanitizeSettings({ translateTargets: 'tr' as never }).translateTargets).toEqual({});
  expect(sanitizeSettings({ translateTargets: ['tr'] as never }).translateTargets).toEqual({});
});

it('muted text (page numbers, the clock, sheet hints) reads at 4.5:1 or more on every theme’s page and its menus', async () => {
  const { THEMES } = await import('../src/lib/settings');
  // WCAG 2.1 relative luminance and contrast ratio.
  const luminance = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  for (const [name, t] of Object.entries(THEMES)) {
    expect([name, 'page', contrast(t.muted, t.bg) >= 4.5]).toEqual([name, 'page', true]);
    expect([name, 'menus', contrast(t.muted, t.chrome) >= 4.5]).toEqual([name, 'menus', true]);
  }
});
