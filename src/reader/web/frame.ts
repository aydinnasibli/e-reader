// Where the text goes in the reader's WebView, for a window, its safe-area
// insets and the margin. Pure, so it's tested.

import type { PageFrame } from './protocol';

export const HEADER = 30;
export const FOOTER = 30;
/** The header and footer have a fixed height: their text grows with the phone's text size only this far. */
export const META_SCALE = 1.4;

type Insets = { top: number; bottom: number; left: number; right: number };

/**
 * Where the text goes in the WebView. Page mode: between the header and the
 * footer, one column a screen, or two side by side on a wide landscape screen
 * (each half a page with the same margins). Scroll mode: the whole screen.
 */
export function webFrame(win: { width: number; height: number }, insets: Insets, margin: number, mode: 'page' | 'scroll'): PageFrame {
  const left = insets.left + margin;
  const right = insets.right + margin;
  if (mode === 'scroll') {
    return { width: win.width, height: win.height, left, right, top: insets.top + 12, bottom: insets.bottom + 40, column: win.width - left - right, gap: 0, spread: false };
  }
  const spread = win.width > win.height && win.width >= 640;
  const pitch = spread ? win.width / 2 : win.width;
  return {
    width: win.width,
    height: Math.floor(win.height - insets.top - insets.bottom - HEADER - FOOTER),
    left,
    right,
    top: 0,
    bottom: 0,
    column: pitch - left - right,
    gap: left + right,
    spread,
  };
}
