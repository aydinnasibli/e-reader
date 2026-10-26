/// <reference types="jest" />
// The app's colours (outside the reading page) keep text readable: every
// colour text is drawn in is at least 4.5:1 against what it's drawn on (WCAG
// AA), in the light and the dark theme.

import { renderHook } from '@testing-library/react-native';
import { type AppColors, useAppColors } from '@/ui/theme';

let mockScheme: 'light' | 'dark' = 'light';
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({ __esModule: true, default: () => mockScheme }));

/** WCAG contrast ratio of two #RRGGBB colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

async function colors(scheme: 'light' | 'dark'): Promise<AppColors> {
  mockScheme = scheme;
  return (await renderHook(() => useAppColors())).result.current;
}

// Text colour → the backgrounds it is drawn on.
const PAIRS: [keyof AppColors, (keyof AppColors)[]][] = [
  ['text', ['bg', 'card', 'elevated', 'chip']],
  ['secondary', ['bg', 'card', 'elevated', 'chip']], // labels, placeholders, the search box
  ['accent', ['bg', 'card', 'elevated']], // links, "New", the add button
  ['accentText', ['accent']], // buttons: Read, Add books, Update, Save
  ['danger', ['bg', 'card', 'elevated']], // Remove, a book that failed
  ['dangerText', ['danger']], // the "Failed to open" badge
];

it.each(['light', 'dark'] as const)('%s theme: text is at least 4.5:1 on what it is drawn on', async (scheme) => {
  const c = await colors(scheme);
  expect(c.dark).toBe(scheme === 'dark');
  const low: string[] = [];
  for (const [fg, bgs] of PAIRS) {
    for (const bg of bgs) {
      const r = contrast(String(c[fg]), String(c[bg]));
      if (r < 4.5) low.push(`${fg} on ${bg}: ${r.toFixed(2)}`);
    }
  }
  expect(low).toEqual([]);
});
