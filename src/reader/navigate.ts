// Moving around a book from the menu: chapter by chapter, or to a page or
// percentage typed in. Pure, so it's tested.

import type { Position, TocEntry } from '@/engine/types';

/**
 * Block to go to for the previous (-1) or next (1) chapter from `pos`, or
 * null if there is none. "Previous" first goes back to the start of the
 * current chapter, like turning to its first page.
 */
export function chapterTarget(toc: TocEntry[], pos: Position, dir: 1 | -1): number | null {
  const { b } = pos;
  // Contents entries can be nested or share a block (a part and its first chapter): starts only.
  const starts = [...new Set(toc.map((t) => t.b))].sort((x, y) => x - y);
  if (dir === 1) return starts.find((s) => s > b) ?? null;
  const before = starts.filter((s) => s <= b);
  const current = before.at(-1);
  if (current === undefined) return null;
  if (current < b || pos.o > 0) return current;
  return before.at(-2) ?? null;
}

/**
 * Fraction of the book (0..1) for what was typed: a page number ("45", when
 * pages are counted) or a percentage ("45%", or "45" without pages). Null if
 * it isn't one. A page is aimed at its middle: its start is right on the
 * edge with the page before.
 */
export function parseGoTo(input: string, totalPages: number | null): number | null {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(%?)\s*$/.exec(input);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  if (m[2] || totalPages === null) return n >= 0 && n <= 100 ? n / 100 : null;
  if (!Number.isInteger(n) || n < 1 || n > totalPages) return null;
  return (n - 0.5) / totalPages;
}
