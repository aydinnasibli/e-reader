// On iPhone, selection handles are placed from measured widths (React Native
// can't say where a letter is drawn), so they're only right if justified
// lines are filled the way iOS fills them: TextKit opens the gaps between
// letters too once a line is loose, not only the spaces. The fixture is
// TextKit's own layout of paragraphs the constants weren't fitted on, laid
// out as React Native does on iOS (bench/textkit, `node bench/textkit/fixture.mjs`).

import { describe, expect, it } from 'vitest';
import { type Metrics, lineCarets, textKitShares } from '../src/reader/hitTest';
import type { Line } from '../src/reader/paginate';
import data from './fixtures/textkit-justified.json';

interface Case {
  text: string;
  size: number;
  width: number;
  /** TextKit's lines: characters, used width, height, and the caret's x before each character and after the last. */
  lines: { start: number; end: number; w: number; height: number; xs: number[] }[];
  /** What CharProbe measures at the paragraph's size. */
  chars: Record<string, number>;
  words: Record<string, number>;
}
const fixture = data as unknown as Case[];
const space = (ch: string) => /\s/.test(ch);

/** Metrics as metricsOf builds them, from what CharProbe measured at the paragraph's size. */
function metrics(c: Case, justification: Metrics['justification']): Metrics {
  const { chars, words } = c;
  return {
    advance: (i) => (c.text[i] === undefined || c.text[i] === '­' || c.text[i] === '\n' ? 0 : (chars[c.text[i]] ?? 0)),
    word: (i, j) => words[c.text.slice(i, j).replace(/[­\n]/g, '')],
    hyphen: chars['-'],
    align: 'justify',
    justification,
    fontSize: c.size,
  };
}

/** How far the estimated caret is from TextKit's at the start and end of every word: where handles go. */
function errors(justification: Metrics['justification']): number[] {
  const out: number[] = [];
  for (const c of fixture) {
    const lines: Line[] = c.lines.map((l) => ({ start: l.start, end: l.end, height: l.height, w: l.w }));
    const m = metrics(c, justification);
    c.lines.forEach((l, i) => {
      const xs = lineCarets(c.text, lines, lines[i], c.width, m, i === lines.length - 1);
      for (let k = l.start; k < l.end; k++) {
        const edge = (!space(c.text[k]) && (k === l.start || space(c.text[k - 1]))) || (k > l.start && !space(c.text[k - 1]) && space(c.text[k]));
        if (edge) out.push(Math.abs(xs[k - l.start] - l.xs[k - l.start]));
      }
    });
  }
  return out.sort((a, b) => a - b);
}

describe('iPhone: justified lines as TextKit fills them', () => {
  // The fixture's paragraphs are hard ones (narrow columns, large text, long
  // Russian words): 685 word edges, 9 of them more than 5 points off.
  it('handles land where TextKit draws the words, nearly all within a point', () => {
    const e = errors('textkit');
    expect(e.length).toBeGreaterThan(600);
    expect(e[Math.floor(e.length * 0.9)]).toBeLessThan(0.6);
    expect(e[Math.floor(e.length * 0.95)]).toBeLessThan(1.5);
    expect(e.filter((x) => x > 5).length / e.length).toBeLessThan(0.02);
    expect(e[e.length - 1]).toBeLessThan(12);
  });

  it('widening only the spaces (as Android does) is off by whole words on loose lines', () => {
    const e = errors('spaces');
    expect(e[e.length - 1]).toBeGreaterThan(100);
    expect(e.filter((x) => x > 5).length).toBeGreaterThan(5 * errors('textkit').filter((x) => x > 5).length);
  });

  it('spaces widen alone on a snug line; a loose one opens the letters too, up to a limit', () => {
    expect(textKitShares(20, 4, 30, 20)).toEqual({ space: 5, gap: 0 });
    const loose = textKitShares(120, 3, 20, 20);
    expect(loose.gap).toBeGreaterThan(0);
    expect(3 * loose.space + 20 * loose.gap).toBeCloseTo(120);
    expect(textKitShares(400, 2, 10, 20).gap).toBeCloseTo(0.29 * 20);
    // One long word: only its letters can spread.
    expect(textKitShares(30, 0, 10, 20)).toEqual({ space: 0, gap: 3 });
  });
});
