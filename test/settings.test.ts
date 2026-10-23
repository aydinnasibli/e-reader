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
