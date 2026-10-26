import { describe, expect, it } from 'vitest';
import { cutRange } from '../src/lib/highlightRanges';
import { dragRanges, exactText, selectBetween, selectionRanges, selectionText } from '../src/reader/selection';

const TEXT = 'The quick brown fox jumps over the lazy dog';

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


describe('copying a selection', () => {
  const texts: Record<number, string | null> = { 0: 'The quick brown fox', 1: null, 2: 'jumps over the lazy dog' };
  const textOf = (b: number) => texts[b] ?? null;

  it('takes exactly the characters selected, not the whole words', () => {
    // From inside "quick" to inside "brown" (the last character is included).
    expect(exactText({ a: { b: 0, o: 6 }, z: { b: 0, o: 11 } }, textOf)).toBe('ick br');
    expect(selectionText({ a: { b: 0, o: 6 }, z: { b: 0, o: 11 } }, textOf)).toBe('quick brown');
  });

  it('across paragraphs, past a picture, either way round', () => {
    expect(exactText({ a: { b: 0, o: 16 }, z: { b: 2, o: 4 } }, textOf)).toBe('fox\njumps');
    expect(exactText({ a: { b: 2, o: 4 }, z: { b: 0, o: 16 } }, textOf)).toBe('fox\njumps');
    // Up to the end of a paragraph (a selection ending at the start of the next).
    expect(exactText({ a: { b: 0, o: 16 }, z: { b: 0, o: Number.MAX_SAFE_INTEGER } }, textOf)).toBe('fox');
  });
});
