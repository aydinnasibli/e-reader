// Which character of a paragraph sits under a finger. React Native has no
// API for that, so it is worked out from the measured lines: the line from
// the height, the character from the position along the line, weighting
// letters by their usual width. Good to a word; the selection sheet lets the
// reader adjust from there.

import type { Line } from './paginate';

function weight(ch: string): number {
  if (ch === '­') return 0; // soft hyphen: invisible unless the line breaks there
  if (ch === ' ') return 0.28;
  if (/[iljtfrI1.,;:'!|()[\]"`·]/.test(ch)) return 0.3;
  if (/[mwMW@%—]/.test(ch)) return 0.85;
  if (ch >= 'A' && ch <= 'Z') return 0.66;
  if (/[А-ЯЁ]/.test(ch)) return 0.68;
  return 0.52;
}

/** Index in text[start, end) found at fraction `frac` (0..1) of the line's width. */
export function charAtFraction(text: string, start: number, end: number, frac: number): number {
  let total = 0;
  for (let i = start; i < end; i++) total += weight(text[i]);
  if (end <= start || total <= 0) return start;
  const target = Math.max(0, Math.min(1, frac)) * total;
  let acc = 0;
  for (let i = start; i < end; i++) {
    acc += weight(text[i]);
    if (acc >= target) return i;
  }
  return end - 1;
}

/**
 * Drawn-text offset under the point (x, y), measured from the top-left of the
 * text of a paragraph showing drawn range [from, to) (a page may show part of
 * a paragraph). `width` is the width lines are broken at; justified lines
 * (all but the paragraph's last) fill it.
 */
export function hitText(text: string, lines: Line[], from: number, to: number, x: number, y: number, width: number, justified: boolean): number {
  const shown = lines.filter((l) => l.start >= from && l.start < to);
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
  const lastOfParagraph = line === lines[lines.length - 1];
  const lineWidth = justified && !lastOfParagraph ? width : (line.w ?? width);
  return charAtFraction(text, line.start, line.end, lineWidth > 0 ? x / lineWidth : 0);
}
