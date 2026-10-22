// Cuts one chunk of measured blocks into pages. Pure functions, no React.

import type { Block } from '@/engine/types';
import type { Look } from './look';

/** One measured line: [start, end) in the block's drawn text, and its height. */
export interface Line {
  start: number;
  end: number;
  height: number;
  /** Drawn width of the line, when the text engine reported it (for hit testing). */
  w?: number;
}

export type Measure =
  | { kind: 'text'; lines: Line[]; length: number }
  | { kind: 'box'; height: number };

export interface PageItem {
  /** Global block index. */
  b: number;
  /** Drawn-text range shown on this page (text blocks only). */
  s: number;
  e: number;
  /** Whether this is the first thing on its page (top margin dropped). */
  top: boolean;
  /** Fixed height for image boxes. */
  h?: number;
}

export interface Page {
  items: PageItem[];
}

/**
 * Map the lines reported by the text engine onto character offsets of the
 * drawn text. Engines may drop or add a trailing newline per line, so each
 * line is located by searching near where it should start.
 */
export function lineRanges(full: string, lines: { text: string; height: number; width?: number }[]): Line[] {
  const out: Line[] = [];
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text;
    let start = pos;
    if (t && !full.startsWith(t, pos)) {
      const probe = t.replace(/\n$/, '').slice(0, 24);
      const k = probe ? full.indexOf(probe, pos) : -1;
      if (k >= 0 && k - pos <= 4) start = k;
    }
    let end = i === lines.length - 1 ? full.length : Math.min(full.length, start + t.length);
    if (end < start) end = start;
    const w = lines[i].width;
    out.push(w ? { start, end, height: lines[i].height, w } : { start, end, height: lines[i].height });
    pos = end;
  }
  return out;
}

/** Rough line breaking for when the text engine didn't report (should be rare). */
export function estimateLines(text: string, look: Look, width: number): Line[] {
  // Errs on the side of more lines: a short page is fine, text cut off by an overfull one is lost.
  const perLine = Math.max(8, Math.floor((width - look.paddingLeft) / (look.fontSize * 0.62)));
  const out: Line[] = [];
  for (let s = 0; s < text.length; s += perLine) out.push({ start: s, end: Math.min(text.length, s + perLine), height: look.lineHeight });
  if (!out.length) out.push({ start: 0, end: 0, height: look.lineHeight });
  return out;
}

export function paginate(blocks: Block[], firstBlock: number, measures: Measure[], looks: Look[], pageHeight: number): Page[] {
  const pages: Page[] = [];
  let items: PageItem[] = [];
  let y = 0;
  const newPage = () => {
    if (items.length) pages.push({ items });
    items = [];
    y = 0;
  };

  for (let i = 0; i < blocks.length; i++) {
    const m = measures[i];
    const look = looks[i];
    const b = firstBlock + i;
    if (m.kind === 'box') {
      if (m.height <= 0) continue;
      const mt = items.length ? look.marginTop : 0;
      if (items.length && y + mt + m.height > pageHeight) newPage();
      const top = items.length === 0;
      y += (top ? 0 : mt) + m.height;
      items.push({ b, s: 0, e: 0, top, h: Math.min(m.height, pageHeight) });
      continue;
    }
    const lines = m.lines;
    let li = 0;
    let mt = look.marginTop;
    while (li < lines.length) {
      const top = items.length === 0;
      const gap = top ? 0 : mt;
      // Fit as many lines as possible; always at least one on an empty page.
      let used = gap;
      let n = 0;
      while (li + n < lines.length && (y + used + lines[li + n].height <= pageHeight || (top && n === 0))) {
        used += lines[li + n].height;
        n++;
      }
      if (n === 0) {
        newPage();
        continue;
      }
      items.push({ b, s: lines[li].start, e: lines[li + n - 1].end, top });
      y += used;
      li += n;
      mt = 0;
      if (li < lines.length) newPage();
    }
    y += look.marginBottom;
  }
  newPage();
  if (!pages.length) pages.push({ items: [] });
  return pages;
}

/** Index of the page showing the given block/character (drawn-text offset). */
export function pageOf(pages: Page[], block: number, drawnOffset: number): number {
  let found = 0;
  for (let p = 0; p < pages.length; p++) {
    const first = pages[p].items[0];
    if (!first) continue;
    if (first.b < block || (first.b === block && first.s <= drawnOffset)) found = p;
    else break;
  }
  return found;
}
