import { describe, expect, it } from 'vitest';
import { cutRange } from '../src/lib/highlightRanges';
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


describe('Chinese and Japanese (no spaces between words)', () => {
  it('a long press selects one character, not the whole sentence', () => {
    const zh = '我们在海上航行。The ship 很大';
    const t = tokenize(zh);
    expect(t[wordAt(t, 1)].text).toBe('们');
    expect(t[wordAt(t, 9)].text).toBe('The');
    expect(t.filter((x) => x.word).map((x) => x.text)).toEqual(['我', '们', '在', '海', '上', '航', '行', '。', 'The', 'ship', '很', '大']);
    const ja = 'ひらがなとカタカナ';
    expect(tokenize(ja).map((x) => x.text)).toHaveLength(ja.length);
    // Offsets still line up with the text.
    for (const x of tokenize(zh)) expect(zh.slice(x.start, x.start + x.text.length)).toBe(x.text);
  });
});
