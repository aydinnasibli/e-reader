// Which character of a paragraph sits under a finger, and where a character
// is drawn. React Native has no API for either, so both are worked out from
// the measured lines (where they break, how high and wide they are) and the
// width of each character (see charWidths): the line from the height, the
// character from the widths along it.

import { estimate } from './charWidths';
import type { Line } from './paginate';

/** How a paragraph's characters are laid along its lines. */
export interface Metrics {
  /** Width of drawn character i on its own (before justification; a soft hyphen is 0). */
  advance(i: number): number;
  /** Width of the hyphen drawn where a line breaks at a soft hyphen. */
  hyphen: number;
  /**
   * Width of drawn characters [start, end), a word with no spaces, as the
   * text engine lays it out together (closer than the letters' widths add up
   * to: kerning, ligatures); undefined when not known.
   */
  word?(start: number, end: number): number | undefined;
  align: 'left' | 'center' | 'right' | 'justify';
  /**
   * How a justified line is filled: 'spaces' (Android) widens only the spaces
   * between words; 'textkit' (iOS) also opens the gaps between letters of a
   * loose line (see textKitShares), and needs `fontSize`.
   */
  justification?: 'spaces' | 'textkit';
  fontSize?: number;
}

// How TextKit (iOS) fills a justified line, measured on its text engine laid
// out the way React Native lays it out (bench/textkit), in ems of the
// paragraph's size. The spaces widen alone up to TEXTKIT_SPACES_ONLY each.
// A looser line also opens every gap between two letters of a word, up to
// TEXTKIT_MAX_GAP, the spaces keeping TEXTKIT_SPACE_LEAD more than those gaps
// and taking whatever the gaps can't. A line without spaces spreads its letters.
const TEXTKIT_SPACES_ONLY = 0.54;
const TEXTKIT_SPACE_LEAD = 0.46;
const TEXTKIT_MAX_GAP = 0.29;

/** What each space and each gap between letters gets of a justified line's `slack` on iOS. */
export function textKitShares(slack: number, spaces: number, gaps: number, size: number): { space: number; gap: number } {
  if (!spaces) return { space: 0, gap: gaps ? slack / gaps : 0 };
  if (slack / spaces <= TEXTKIT_SPACES_ONLY * size) return { space: slack / spaces, gap: 0 };
  const gap = Math.min(TEXTKIT_MAX_GAP * size, Math.max(0, (slack - spaces * TEXTKIT_SPACE_LEAD * size) / (spaces + gaps)));
  return { space: (slack - gaps * gap) / spaces, gap };
}

/** Metrics from usual letter widths, for one font size (tests, and before anything is measured). */
export function estimatedMetrics(text: string, fontSize: number, align: Metrics['align']): Metrics {
  return { advance: (i) => estimate(text[i] ?? '') * fontSize, hyphen: 0.33 * fontSize, align };
}

/**
 * Where the caret sits before each character of a line, and after the last:
 * x positions from the left of the text, `line.end - line.start + 1` of them.
 * Justified lines (all but the last drawn, or one before a line break)
 * stretch their spaces to fill `width`; other lines take their measured width.
 * `lastShown`: the line is the last of the text drawn (a page shows part of a
 * paragraph, drawn on its own, so its last line isn't justified either).
 */
export function lineCarets(text: string, lines: Line[], line: Line, width: number, m: Metrics, lastShown = false): number[] {
  const { start, end } = line;
  let ink = end; // without the spaces (and line break) it ends with
  while (ink > start && /\s/.test(text[ink - 1])) ink--;
  const hyphen = ink === end && end < text.length && text[end - 1] === '­' ? m.hyphen : 0;
  // Each character's width on this line: a word's letters fill the word's own measured width.
  const adv: number[] = [];
  for (let k = start; k < end; ) {
    if (/\s/.test(text[k])) {
      adv.push(m.advance(k++));
      continue;
    }
    let j = k;
    while (j < end && !/\s/.test(text[j])) j++;
    let sum = 0;
    for (let q = k; q < j; q++) sum += m.advance(q);
    const together = j - k > 1 ? m.word?.(k, j) : undefined;
    // Far off: the word was measured in some other way; keep the letters' widths.
    const f = together !== undefined && sum > 0 && Math.abs(together / sum - 1) < 0.25 ? together / sum : 1;
    for (let q = k; q < j; q++) adv.push(m.advance(q) * f);
    k = j;
  }
  const textkit = m.justification === 'textkit' && m.fontSize !== undefined;
  // What justifying widens: the spaces between words (iOS: any space before
  // the line's end, the indent's too), and on iOS the gaps between letters.
  const widened = (k: number) => k < ink && (textkit ? /\s/.test(text[k]) : text[k] === ' ');
  const isGap = (k: number) => textkit && k + 1 < ink && !/\s/.test(text[k]) && !/\s/.test(text[k + 1]);
  let natural = hyphen;
  let spaces = 0;
  let gaps = 0;
  for (let k = start; k < ink; k++) {
    natural += adv[k - start];
    if (widened(k)) spaces++;
    else if (isGap(k)) gaps++;
  }
  const last = lastShown || line === lines[lines.length - 1] || text[end - 1] === '\n';
  let scale = 1;
  let stretch = 0;
  let gap = 0;
  let left = 0;
  if (m.align === 'justify' && !last && natural > 0 && textkit) {
    ({ space: stretch, gap } = textKitShares(Math.max(0, width - natural), spaces, gaps, m.fontSize!));
  } else if (m.align === 'justify' && !last && natural > 0 && spaces) {
    // Android only widens the spaces between words: a line without any (one
    // long word) stays as it is, at the left.
    stretch = Math.max(0, width - natural) / spaces;
  } else {
    // The text engine's width corrects small differences (kerning); a big one means it measured something else.
    // Android's width counts the spaces the line ends with, which aren't drawn.
    const used = line.w;
    let trailing = 0;
    for (let k = ink; k < end; k++) trailing += adv[k - start];
    const measured = used && Math.abs(used - natural - trailing) < Math.abs(used - natural) ? natural + trailing : natural;
    if (used && measured > 0 && Math.abs(used / measured - 1) < 0.12) scale = used / measured;
    const drawnWidth = natural * scale;
    if (m.align === 'center') left = Math.max(0, (width - drawnWidth) / 2);
    else if (m.align === 'right') left = Math.max(0, width - drawnWidth);
  }
  const xs = [left];
  let x = left;
  for (let k = start; k < end; k++) {
    x += adv[k - start] * scale + (stretch && widened(k) ? stretch : 0) + (gap && isGap(k) ? gap : 0);
    xs.push(x);
  }
  return xs;
}

/** The lines of a paragraph shown for its drawn range [from, to) (a page may show part of it). */
const shownLines = (lines: Line[], from: number, to: number) => lines.filter((l) => l.start >= from && l.start < to);

/**
 * Drawn-text offset under the point (x, y), measured from the top-left of the
 * text of a paragraph showing drawn range [from, to). `width` is the width
 * lines are broken at.
 */
export function hitText(text: string, lines: Line[], from: number, to: number, x: number, y: number, width: number, m: Metrics): number {
  const shown = shownLines(lines, from, to);
  if (!shown.length) return from;
  let top = 0;
  let line = shown[shown.length - 1];
  for (const l of shown) {
    if (y < top + l.height) {
      line = l;
      break;
    }
    top += l.height;
  }
  if (line.end <= line.start) return line.start;
  const xs = lineCarets(text, lines, line, width, m, line === shown[shown.length - 1]);
  for (let k = line.start; k < line.end; k++) if (x < xs[k - line.start + 1]) return k;
  return line.end - 1;
}

/** Where a caret sits in a paragraph's text: from its top-left, with the line's height. */
export interface Caret {
  x: number;
  y: number;
  h: number;
}

/**
 * The reverse of hitText: where the caret before drawn character `i` sits
 * (`edge` 'end': after character i - 1, so a selection's end stays on its
 * last line), for the part [from, to) of a paragraph shown. Null if that
 * character isn't shown.
 */
export function caretInText(
  text: string,
  lines: Line[],
  from: number,
  to: number,
  i: number,
  edge: 'start' | 'end',
  width: number,
  m: Metrics,
): Caret | null {
  const shown = shownLines(lines, from, to);
  const at = edge === 'end' ? Math.max(i - 1, 0) : i;
  let top = 0;
  for (const line of shown) {
    if (at >= line.start && (at < line.end || line === shown[shown.length - 1])) {
      if (at >= line.end && line !== lines[lines.length - 1]) return null;
      const xs = lineCarets(text, lines, line, width, m, line === shown[shown.length - 1]);
      const k = Math.min(at + (edge === 'end' ? 1 : 0), line.end) - line.start;
      return { x: xs[k], y: top, h: line.height };
    }
    top += line.height;
  }
  return null;
}

// ---- where the phone drew the text (see drawnLayout) ----

/** A text's lines as drawn: positions in window points, offsets in the text drawn (a page's slice of a paragraph). */
export interface DrawnLines {
  /** Where the text's content starts. */
  x: number;
  y: number;
  length: number;
  /** Each line's characters [start, end), top and bottom, and the caret's x before each character and after the last. */
  lines: { start: number; end: number; top: number; bottom: number; xs: number[] }[];
}

/** The character under a point (window coordinates); above, below or beside the text, the nearest one. */
export function hitDrawn(d: DrawnLines, pageX: number, pageY: number): number {
  const y = pageY - d.y;
  const line = d.lines.find((l) => y < l.bottom) ?? d.lines[d.lines.length - 1];
  if (!line || line.end <= line.start) return line?.start ?? 0;
  const x = pageX - d.x;
  for (let k = line.start; k < line.end; k++) if (x < line.xs[k - line.start + 1]) return k;
  return line.end - 1;
}

/**
 * Where the caret before character `i` sits ('end': after character i - 1, on
 * its line), in window coordinates; null if that character isn't in this text.
 */
export function caretDrawn(d: DrawnLines, i: number, edge: 'start' | 'end'): Caret | null {
  const at = edge === 'end' ? i - 1 : i;
  if (at < 0 || at >= d.length) return null;
  const line = d.lines.find((l) => at >= l.start && at < l.end);
  if (!line) return null;
  const x = line.xs[at + (edge === 'end' ? 1 : 0) - line.start];
  return { x: d.x + x, y: d.y + line.top, h: line.bottom - line.top };
}
