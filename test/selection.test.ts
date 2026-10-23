import { describe, expect, it } from 'vitest';
import { cutRange } from '../src/lib/highlightRanges';
import { caretInText, charAtFraction, hitText } from '../src/reader/hitTest';
import type { Line } from '../src/reader/paginate';
import { dragRanges, selectBetween, selectionRanges, selectionText, tapWord, tokenize, tokensFor, wordAt } from '../src/reader/selection';

const TEXT = 'The quick brown fox jumps over the lazy dog';

describe('word selection', () => {
  const tokens = tokenize(TEXT);
  const word = (i: number) => tokens[i].text;

  it('finds the word at a character, or the nearest one on a space', () => {
    expect(word(wordAt(tokens, 0))).toBe('The');
    expect(word(wordAt(tokens, 12))).toBe('brown');
    expect(word(wordAt(tokens, 9))).toBe('quick'); // the space after "quick"
    expect(word(wordAt(tokens, 999))).toBe('dog');
    expect(wordAt(tokenize('   '), 1)).toBe(-1);
  });

  it('long-press selects one word; taps extend; a tap inside starts over', () => {
    const fox = wordAt(tokens, TEXT.indexOf('fox'));
    let sel = { a: fox, z: fox };
    sel = tapWord(sel, wordAt(tokens, TEXT.indexOf('over')));
    expect(tokens.slice(sel.a, sel.z + 1).map((t) => t.text).join('')).toBe('fox jumps over');
    sel = tapWord(sel, wordAt(tokens, TEXT.indexOf('jumps')));
    expect(sel).toEqual({ a: wordAt(tokens, TEXT.indexOf('jumps')), z: wordAt(tokens, TEXT.indexOf('jumps')) });
  });

  it('maps a character range to the words it touches', () => {
    const s = TEXT.indexOf('brown');
    const sel = tokensFor(tokens, s, s + 'brown fox'.length)!;
    expect(word(sel.a)).toBe('brown');
    expect(word(sel.z)).toBe('fox');
    expect(tokensFor(tokens, 3, 4)).toBeNull(); // only a space
  });
});

describe('highlight ranges', () => {
  const h = (id: string, s: number, e: number, b = 0) => ({ id, b, s, e, text: TEXT.slice(s, e) });
  let n = 0;
  const id = () => `new${++n}`;

  it('highlighting one word inside a paragraph highlight splits it instead of deleting it', () => {
    const whole = h('p', 0, TEXT.length);
    const fs = TEXT.indexOf('fox');
    const out = cutRange([whole], 0, fs, fs + 3, id);
    // The pieces left don't keep the spaces at their cut ends.
    expect(out.map((x) => x.text)).toEqual(['The quick brown', 'jumps over the lazy dog']);
    expect(out[0].id).toBe('p');
    expect(out[1].id).not.toBe('p');
  });

  it('a note stays with one piece when its highlight is split', () => {
    const fs = TEXT.indexOf('fox');
    const out = cutRange([{ ...h('p', 0, TEXT.length), note: 'Aesop?' }], 0, fs, fs + 3, id);
    expect(out.map((x) => x.note)).toEqual(['Aesop?', undefined]);
  });

  it('trims overlapping edges, drops covered highlights, leaves others alone', () => {
    const list = [h('a', 0, 9), h('b', 10, 15), h('c', 16, 25), h('other-block', 0, 5, 1)];
    const out = cutRange(list, 0, 4, 20, id);
    expect(out.map((x) => [x.id, x.s, x.e, x.text])).toEqual([
      ['a', 0, 3, 'The'],
      ['c', 20, 25, 'jumps'],
      ['other-block', 0, 5, 'The q'],
    ]);
  });
});

describe('hit testing', () => {
  // Two lines of a paragraph: "The quick brown " / "fox jumps over"
  const text = 'The quick brown fox jumps over';
  const lines: Line[] = [
    { start: 0, end: 16, height: 20, w: 150 },
    { start: 16, end: 30, height: 20, w: 120 },
  ];

  it('picks the line by height and the character along it', () => {
    expect(text[hitText(text, lines, 0, 30, 2, 5, 200, false)]).toBe('T');
    // Right edge of the first line, left-aligned: inside "brown".
    expect('brown'.includes(text[hitText(text, lines, 0, 30, 140, 5, 200, false)])).toBe(true);
    // Second line, start.
    expect(text[hitText(text, lines, 0, 30, 1, 25, 200, false)]).toBe('f');
    // Below the text: last line.
    expect(hitText(text, lines, 0, 30, 1, 500, 200, false)).toBeGreaterThanOrEqual(16);
  });

  it('justified lines span the full width', () => {
    // At 75% of the full width a justified first line is in "brown"; measured
    // against its natural width (150) it would be past the end.
    const i = hitText(text, lines, 0, 30, 150, 5, 200, true);
    expect(text.slice(0, 16).trim().split(' ').pop()).toBe('brown');
    expect(i).toBeLessThan(16);
    expect(i).toBeGreaterThanOrEqual(10);
  });

  it('only considers the lines shown on this page', () => {
    // The page shows the paragraph from the second line on.
    expect(text[hitText(text, lines, 16, 30, 1, 5, 200, false)]).toBe('f');
  });

  it('weights letters by width', () => {
    // "iiii" is narrow, "MMMM" wide: halfway along "iiiiMMMM" is in the M's... early.
    const t = 'iiiiMMMM';
    const mid = charAtFraction(t, 0, t.length, 0.5);
    expect(t[mid]).toBe('M');
    expect(mid).toBeLessThanOrEqual(5);
  });
});

describe('drag to highlight', () => {
  const texts: Record<number, string | null> = { 0: 'The quick brown fox', 1: null, 2: 'jumps over the lazy dog' };
  const textOf = (b: number) => texts[b] ?? null;

  it('widens to whole words, in either direction', () => {
    // From inside "quick" to inside "brown".
    expect(dragRanges({ b: 0, o: 6 }, { b: 0, o: 11 }, textOf)).toEqual([{ b: 0, s: 4, e: 15 }]);
    expect(dragRanges({ b: 0, o: 11 }, { b: 0, o: 6 }, textOf)).toEqual([{ b: 0, s: 4, e: 15 }]);
  });

  it('a tap-sized drag on one word highlights that word', () => {
    expect(dragRanges({ b: 0, o: 17 }, { b: 0, o: 17 }, textOf)).toEqual([{ b: 0, s: 16, e: 19 }]);
  });

  it('spans paragraphs and skips images', () => {
    expect(dragRanges({ b: 0, o: 17 }, { b: 2, o: 2 }, textOf)).toEqual([
      { b: 0, s: 16, e: 19 },
      { b: 2, s: 0, e: 5 },
    ]);
  });

  it('never starts or ends on a space', () => {
    expect(dragRanges({ b: 0, o: 3 }, { b: 0, o: 3 }, textOf)).toEqual([]);
    expect(dragRanges({ b: 0, o: 3 }, { b: 0, o: 5 }, textOf)).toEqual([{ b: 0, s: 4, e: 9 }]);
  });
});

describe('where a character is on screen (for selection handles)', () => {
  const text = 'The quick brown fox jumps over';
  const lines: Line[] = [
    { start: 0, end: 16, height: 20, w: 150 },
    { start: 16, end: 30, height: 20, w: 120 },
  ];

  it('the start of a line is at its left, on that line', () => {
    expect(caretInText(text, lines, 0, 30, 0, 'start', 200, false)).toEqual({ x: 0, y: 0, h: 20 });
    expect(caretInText(text, lines, 0, 30, 16, 'start', 200, false)).toEqual({ x: 0, y: 20, h: 20 });
  });

  it("a selection's end stays after its last character, on that line", () => {
    // After "brown " (the end of line 1), not at the start of line 2.
    const c = caretInText(text, lines, 0, 30, 16, 'end', 200, false)!;
    expect(c.y).toBe(0);
    expect(c.x).toBeCloseTo(150);
  });

  it('agrees with hit testing: the character found at a caret is that character', () => {
    for (const i of [4, 10, 20, 26]) {
      const c = caretInText(text, lines, 0, 30, i, 'start', 200, false)!;
      // Just right of the caret is character i.
      expect(hitText(text, lines, 0, 30, c.x + 1, c.y + 5, 200, false)).toBe(i);
    }
  });

  it('only the lines shown on this page count', () => {
    expect(caretInText(text, lines, 16, 30, 20, 'start', 200, false)!.y).toBe(0);
    expect(caretInText(text, lines, 16, 30, 4, 'start', 200, false)).toBeNull();
  });
});

describe('selection with handles', () => {
  const texts: Record<number, string | null> = { 0: 'The quick brown fox', 1: null, 2: 'jumps over the lazy dog' };
  const textOf = (b: number) => texts[b] ?? null;

  it('a long-press selects the word under the finger', () => {
    const sel = selectBetween({ b: 0, o: 6 }, { b: 0, o: 6 }, textOf)!;
    expect(selectionText(sel, textOf)).toBe('quick');
  });

  it('dragging a handle across paragraphs (and past the other one) keeps whole words in order', () => {
    // The end handle dragged into the next paragraph...
    let sel = selectBetween({ b: 0, o: 4 }, { b: 2, o: 7 }, textOf)!;
    expect(selectionText(sel, textOf)).toBe('quick brown fox\njumps over');
    // ...then the start handle dragged past it: the selection turns around.
    sel = selectBetween(sel.z, { b: 2, o: 20 }, textOf)!;
    expect(selectionText(sel, textOf)).toBe('over the lazy dog');
    expect(selectionRanges(sel, textOf)).toEqual([{ b: 2, s: 6, e: 23 }]);
  });

  it('only spaces is no selection', () => {
    expect(selectBetween({ b: 0, o: 3 }, { b: 0, o: 3 }, textOf)).toBeNull();
  });
});

