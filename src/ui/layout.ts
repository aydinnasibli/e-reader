// Widths shared by the screens around the reader, so that on a tablet or a
// phone turned on its side text keeps a readable line length instead of rows
// stretching edge to edge. A phone held upright is narrower than the column
// and looks the same as without it.

import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** The widest a screen of text and rows gets (book details, highlights & notes, sheets and menus). */
export const COLUMN_WIDTH = 680;

/**
 * Side padding (or margins) that centre content in a column at most
 * COLUMN_WIDTH wide, at least `gutter` in from the safe edges (clear of the
 * notch of a phone on its side).
 */
export function columnPadding(width: number, insets: { left: number; right: number }, gutter = 0): { paddingLeft: number; paddingRight: number } {
  const side = (width - COLUMN_WIDTH) / 2;
  return { paddingLeft: Math.max(insets.left + gutter, side), paddingRight: Math.max(insets.right + gutter, side) };
}

/** columnPadding() for this screen. */
export function useColumnPadding(gutter = 0): { paddingLeft: number; paddingRight: number } {
  return columnPadding(useWindowDimensions().width, useSafeAreaInsets(), gutter);
}

/** The widest a paragraph in `fontSize` text should be: about 70 characters a line. */
export function measure(fontSize: number): number {
  return Math.round(fontSize * 35);
}

/** About how wide a book in the library's grid is drawn. */
const GRID_CELL = 150;

/** Columns of the library's grid for a width: three on a phone, up to eight on a big tablet. */
export function gridColumns(width: number): number {
  return Math.min(8, Math.max(3, Math.floor(width / GRID_CELL)));
}
