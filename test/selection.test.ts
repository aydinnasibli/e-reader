import { describe, expect, it } from 'vitest';
import { cutRange } from '../src/lib/highlightRanges';
import { charWidth, estimate, probeText, recordWidths, resetWidths, wantedWidths, wordWidth } from '../src/reader/charWidths';
import { type DrawnLines, type Metrics, caretDrawn, caretInText, hitDrawn, hitText } from '../src/reader/hitTest';
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
  // Two lines of a paragraph: "The quick brown " / "fox jumps over", every letter 10 wide.
  const text = 'The quick brown fox jumps over';
  const lines: Line[] = [
    { start: 0, end: 16, height: 20, w: 150 },
    { start: 16, end: 30, height: 20, w: 140 },
  ];
  const ten = (align: Metrics['align'] = 'left'): Metrics => ({ advance: () => 10, hyphen: 10, align });

  it('picks the line by height and the character along it', () => {
    expect(text[hitText(text, lines, 0, 30, 2, 5, 200, ten())]).toBe('T');
    expect(text[hitText(text, lines, 0, 30, 145, 5, 200, ten())]).toBe('n');
    // Second line, start.
    expect(text[hitText(text, lines, 0, 30, 1, 25, 200, ten())]).toBe('f');
    // Below the text: last line.
    expect(hitText(text, lines, 0, 30, 1, 500, 200, ten())).toBeGreaterThanOrEqual(16);
  });

  it('justified lines fill the width by widening the spaces between words, not the letters', () => {
    // "The quick brown" is 150 wide; its two spaces take the other 50 of 200.
    expect(text[hitText(text, lines, 0, 30, 155, 5, 200, ten('justify'))]).toBe('b');
    expect(text[hitText(text, lines, 0, 30, 145, 5, 200, ten('justify'))]).toBe(' ');
    expect(text[hitText(text, lines, 0, 30, 195, 5, 200, ten('justify'))]).toBe('n');
    // A paragraph's last line isn't stretched.
    expect(text[hitText(text, lines, 0, 30, 45, 25, 200, ten('justify'))]).toBe('j');
  });

  it('only considers the lines shown on this page', () => {
    // The page shows the paragraph from the second line on.
    expect(text[hitText(text, lines, 16, 30, 1, 5, 200, ten())]).toBe('f');
  });

  it("the last line on a page isn't stretched: the page draws its part of the paragraph on its own", () => {
    // The page shows only the first line; drawn as the last, it isn't justified.
    expect(caretInText(text, lines, 0, 16, 10, 'start', 200, ten('justify'))!.x).toBe(100);
    // The whole paragraph shown: the same line fills the width (the two spaces before "brown" widen by 25 each).
    expect(caretInText(text, lines, 0, 30, 10, 'start', 200, ten('justify'))!.x).toBe(150);
  });

  it("a line's measured width counts the space it ends with: positions aren't stretched by it", () => {
    // "The quick brown " is 160 with its space, as Android reports it; the caret after "brown" is at 150.
    const reported: Line[] = [
      { start: 0, end: 16, height: 20, w: 160 },
      { start: 16, end: 30, height: 20, w: 140 },
    ];
    expect(caretInText(text, reported, 0, 30, 15, 'end', 200, ten())!.x).toBe(150);
  });

  it("uses each character's own width", () => {
    const t = 'iiiiMMMM';
    const m: Metrics = { advance: (i) => (t[i] === 'i' ? 3 : 12), hyphen: 4, align: 'left' };
    const one: Line[] = [{ start: 0, end: 8, height: 20, w: 60 }];
    expect(hitText(t, one, 0, 8, 11, 5, 200, m)).toBe(3); // the i's take 12
    expect(hitText(t, one, 0, 8, 20, 5, 200, m)).toBe(4);
    expect(hitText(t, one, 0, 8, 59, 5, 200, m)).toBe(7);
  });

  it('centred lines (headings) start where the text engine put them', () => {
    const one: Line[] = [{ start: 0, end: 5, height: 30, w: 50 }];
    expect(caretInText('Title', one, 0, 5, 0, 'start', 200, ten('center'))!.x).toBe(75);
  });

  it('measured widths stand in for estimates once the phone has measured them, at the size drawn', () => {
    const face = { fontFamily: 'Serif' };
    resetWidths();
    // Not measured yet: an estimate, and it's asked for at that size.
    expect(charWidth(face, 'W', 20)).toBeCloseTo(estimate('W') * 20);
    const asked = wantedWidths();
    expect(asked.map((w) => [w.size, w.chars])).toEqual([[20, ['W']]]);
    // The probe's lines: the bars, then the bars around WWWW.
    recordWidths(asked[0].key, ['W'], [3, 3 + 4 * 13]);
    expect(charWidth(face, 'W', 20)).toBe(13);
    expect(wantedWidths()).toEqual([]);
    // Another size: the measured one, scaled, until that size is measured too
    // (letters don't scale exactly: the iPhone's font spaces them per size).
    expect(charWidth(face, 'W', 40)).toBe(26);
    const again = wantedWidths();
    expect(again.map((w) => [w.size, w.chars])).toEqual([[40, ['W']]]);
    recordWidths(again[0].key, ['W'], [3, 3 + 4 * 25.5]);
    expect(charWidth(face, 'W', 40)).toBe(25.5);
    expect(charWidth(face, 'W', 20)).toBe(13);
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
    { start: 16, end: 30, height: 20, w: 140 },
  ];
  const m: Metrics = { advance: () => 10, hyphen: 10, align: 'left' };

  it('the start of a line is at its left, on that line', () => {
    expect(caretInText(text, lines, 0, 30, 0, 'start', 200, m)).toEqual({ x: 0, y: 0, h: 20 });
    expect(caretInText(text, lines, 0, 30, 16, 'start', 200, m)).toEqual({ x: 0, y: 20, h: 20 });
  });

  it("a selection's end stays after its last character, on that line", () => {
    // After "brown" (the end of line 1), not at the start of line 2.
    const c = caretInText(text, lines, 0, 30, 15, 'end', 200, m)!;
    expect(c).toEqual({ x: 150, y: 0, h: 20 });
    expect(caretInText(text, lines, 0, 30, 16, 'end', 200, m)!.y).toBe(0);
  });

  it('agrees with hit testing: the character found at a caret is that character', () => {
    for (const i of [4, 10, 20, 26]) {
      const c = caretInText(text, lines, 0, 30, i, 'start', 200, m)!;
      // Just right of the caret is character i.
      expect(hitText(text, lines, 0, 30, c.x + 1, c.y + 5, 200, m)).toBe(i);
    }
  });

  it('only the lines shown on this page count', () => {
    expect(caretInText(text, lines, 16, 30, 20, 'start', 200, m)!.y).toBe(0);
    expect(caretInText(text, lines, 16, 30, 4, 'start', 200, m)).toBeNull();
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

describe('selection handles sit where the text is drawn', () => {
  // "AVATAR ok" on one line: letters 10 wide on their own, but the phone draws
  // "AVATAR" 12 narrower (kerning), as the probe measured.
  const text = 'AVATAR ok';
  const one: Line[] = [{ start: 0, end: 9, height: 20, w: 78 }];
  const kerned = (align: Metrics['align']): Metrics => ({
    advance: () => 10,
    hyphen: 10,
    align,
    word: (s, e) => (text.slice(s, e) === 'AVATAR' ? 48 : undefined),
  });

  it('after a kerned word, the handle is at its measured end, not where the letters add up to', () => {
    // Without the word's width, the caret after AVATAR would be at 60.
    expect(caretInText(text, one, 0, 9, 6, 'start', 200, kerned('left'))!.x).toBeCloseTo(48);
    // Letters inside it share the narrowing.
    expect(caretInText(text, one, 0, 9, 3, 'start', 200, kerned('left'))!.x).toBeCloseTo(24);
    // The next word starts after its space.
    expect(caretInText(text, one, 0, 9, 7, 'start', 200, kerned('left'))!.x).toBeCloseTo(58);
  });

  it('a justified line with one long word is not stretched: justifying only widens spaces', () => {
    const word = 'Unbelievably';
    const lines: Line[] = [
      { start: 0, end: 12, height: 20, w: 120 },
      { start: 12, end: 15, height: 20, w: 30 },
    ];
    const t = word + 'end';
    const m: Metrics = { advance: () => 10, hyphen: 10, align: 'justify' };
    // After the 6th letter: 60, not 6/12 of the 300-wide column.
    expect(caretInText(t, lines, 0, 15, 6, 'start', 300, m)!.x).toBe(60);
    expect(caretInText(t, lines, 0, 15, 12, 'end', 300, m)!.x).toBe(120);
  });

  it('words are measured by the probe on request, then used', () => {
    resetWidths();
    const face = { fontFamily: 'Serif' };
    expect(wordWidth(face, 'AVATAR', 32)).toBeUndefined();
    const asked = wantedWidths();
    expect(asked.map((w) => w.words)).toEqual([['AVATAR']]);
    expect(probeText(asked[0].chars, asked[0].words)).toBe('||\n|AVATAR|');
    // Bars 10 wide; "|AVATAR|" 10 + 200, measured at the size asked for.
    recordWidths(asked[0].key, asked[0].chars, [10, 210], asked[0].words);
    expect(wordWidth(face, 'AVATAR', 32)).toBe(200);
    expect(wantedWidths()).toEqual([]);
    // A failed measurement isn't asked for again.
    expect(wordWidth(face, 'ox', 32)).toBeUndefined();
    const again = wantedWidths();
    recordWidths(again[0].key, again[0].chars, null, again[0].words);
    expect(wordWidth(face, 'ox', 32)).toBeUndefined();
    expect(wantedWidths()).toEqual([]);
  });
});

describe('where the phone drew the text (Android)', () => {
  // "ab cd" over two lines at (100, 50): "ab " (a 0–10, b 10–20, space 20–25) and "cd" (c 0–8, d 8–16).
  const d: DrawnLines = {
    x: 100,
    y: 50,
    length: 5,
    lines: [
      { start: 0, end: 3, top: 0, bottom: 30, xs: [0, 10, 20, 20] },
      { start: 3, end: 5, top: 30, bottom: 60, xs: [0, 8, 16] },
    ],
  };

  it('finds the character under a finger, or the nearest one off the text', () => {
    expect(hitDrawn(d, 105, 60)).toBe(0);
    expect(hitDrawn(d, 115, 60)).toBe(1);
    expect(hitDrawn(d, 300, 60)).toBe(2); // past the end of the line: its last character
    expect(hitDrawn(d, 109, 85)).toBe(4);
    expect(hitDrawn(d, 101, 10)).toBe(0); // above the text: the first line
    expect(hitDrawn(d, 101, 500)).toBe(3); // below it: the last
  });

  it('puts a selection end where the letters are drawn, on their own line', () => {
    expect(caretDrawn(d, 0, 'start')).toEqual({ x: 100, y: 50, h: 30 });
    expect(caretDrawn(d, 2, 'end')).toEqual({ x: 120, y: 50, h: 30 }); // after "ab", not at the next line's start
    expect(caretDrawn(d, 3, 'start')).toEqual({ x: 100, y: 80, h: 30 });
    expect(caretDrawn(d, 5, 'end')).toEqual({ x: 116, y: 80, h: 30 });
    // Not in this text (a page shows another part of the paragraph).
    expect(caretDrawn(d, 5, 'start')).toBeNull();
    expect(caretDrawn(d, 0, 'end')).toBeNull();
  });
});
