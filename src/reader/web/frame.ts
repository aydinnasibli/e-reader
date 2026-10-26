// Where the text goes in the reader's WebView, for a window, its safe-area
// insets, the margin and the text. Pure, so it's tested.

import type { PageFrame } from './protocol';

export const HEADER = 30;
export const FOOTER = 30;
/** The header and footer have a fixed height: their text grows with the phone's text size only this far. */
export const META_SCALE = 1.4;

type Insets = { top: number; bottom: number; left: number; right: number };

/** What decides how long a line of the book's text is. */
export interface Type {
  fontSize: number;
  font?: string;
  letterSpacing?: number;
}

/** A line holds at most about this many characters, as in a printed book; wider screens get wider margins. */
export const MEASURE = 70;
/** Screens at least this wide are kept to MEASURE; a phone held upright is narrower, and keeps its lines as they are. */
const WIDE = 600;
/** Two pages side by side on a screen held upright only when each line still holds this many. */
const TWO_PAGES = 50;
/** Characters a line holds per em of its width, by reading font (measured on English and Turkish prose). */
const CHARS_PER_EM: Record<string, number> = { literata: 2.0, merriweather: 1.98, lora: 2.05, opensans: 2.06, ptserif: 2.16, garamond: 2.54, atkinson: 2.18 };
const CHARS_PER_EM_ELSE = 2.2;

/** The average width of a character of the book's text, in points. */
export function charWidth(t: Type): number {
  return t.fontSize / (CHARS_PER_EM[t.font ?? ''] ?? CHARS_PER_EM_ELSE) + (t.letterSpacing ?? 0);
}

/**
 * Where the text goes in the WebView. Page mode: between the header and the
 * footer, one page a screen, or two side by side in landscape (and on an
 * upright screen wide enough for two good lines). Pages are laid out between
 * the notch and the camera, each with the margin at both sides, so the middle
 * of a spread is twice the margin. Scroll mode: the whole screen. Given the
 * text (`type`), a line on a wide screen is kept to about MEASURE characters:
 * the column is centred, with wider margins.
 */
export function webFrame(win: { width: number; height: number }, insets: Insets, margin: number, mode: 'page' | 'scroll', type?: Type): PageFrame {
  const safe = win.width - insets.left - insets.right;
  const cw = type && win.width >= WIDE ? charWidth(type) : 0;
  const cap = cw ? MEASURE * cw : Infinity;
  if (mode === 'scroll') {
    const column = Math.min(safe - 2 * margin, cap);
    const side = (safe - column) / 2;
    return { width: win.width, height: win.height, left: insets.left + side, right: insets.right + side, top: insets.top + 12, bottom: insets.bottom + 40, column, gap: 0, spread: false };
  }
  const one = safe - 2 * margin;
  const two = safe / 2 - 2 * margin;
  const spread = (win.width > win.height && win.width >= 640) || (one > cap && two >= TWO_PAGES * cw);
  const pitch = spread ? safe / 2 : safe;
  const column = Math.min(pitch - 2 * margin, cap);
  const side = (pitch - column) / 2;
  return {
    width: win.width,
    height: Math.floor(win.height - insets.top - insets.bottom - HEADER - FOOTER),
    left: insets.left + side,
    right: insets.right + side,
    top: 0,
    bottom: 0,
    column,
    gap: pitch - column,
    spread,
    inset: { left: insets.left, right: insets.right },
  };
}
