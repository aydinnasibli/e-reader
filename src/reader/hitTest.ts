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
}

/** Metrics from usual letter widths, for one font size (tests, and before anything is measured). */
export function estimatedMetrics(text: string, fontSize: number, align: Metrics['align']): Metrics {
  return { advance: (i) => estimate(text[i] ?? '') * fontSize, hyphen: 0.33 * fontSize, align };
}

/**
 * Where the caret sits before each character of a line, and after the last:
 * x positions from the left of the text, `line.end - line.start + 1` of them.
 * Justified lines (all but a paragraph's last, or one before a line break)
 * stretch their spaces to fill `width`; other lines take their measured width.
 */
export function lineCarets(text: string, lines: Line[], line: Line, width: number, m: Metrics): number[] {
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
  let natural = hyphen;
  let spaces = 0;
  for (let k = start; k < ink; k++) {
    natural += adv[k - start];
    if (text[k] === ' ') spaces++;
  }
  const last = line === lines[lines.length - 1] || text[end - 1] === '\n';
  let scale = 1;
  let stretch = 0;
  let left = 0;
  // Justifying only widens the spaces between words: a line without any (one
  // long word) stays as it is, at the left.
  if (m.align === 'justify' && !last && natural > 0 && spaces) {
    stretch = Math.max(0, width - natural) / spaces;
  } else {
    // The text engine's width corrects small differences (kerning); a big one means it measured something else.
    const used = line.w;
    if (used && natural > 0 && Math.abs(used / natural - 1) < 0.12) scale = used / natural;
    const drawnWidth = natural * scale;
    if (m.align === 'center') left = Math.max(0, (width - drawnWidth) / 2);
    else if (m.align === 'right') left = Math.max(0, width - drawnWidth);
  }
  const xs = [left];
  let x = left;
  for (let k = start; k < end; k++) {
    x += adv[k - start] * scale + (stretch && text[k] === ' ' && k < ink ? stretch : 0);
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
  const xs = lineCarets(text, lines, line, width, m);
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
      const xs = lineCarets(text, lines, line, width, m);
      const k = Math.min(at + (edge === 'end' ? 1 : 0), line.end) - line.start;
      return { x: xs[k], y: top, h: line.height };
    }
    top += line.height;
  }
  return null;
}
