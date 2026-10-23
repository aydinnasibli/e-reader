import { describe, expect, it } from 'vitest';
import type { Block } from '../src/engine/types';
import type { Look } from '../src/reader/look';
import { type Measure, lineRanges, pageOf, paginate } from '../src/reader/paginate';

const look = (mt = 0, mb = 0): Look => ({
  fontSize: 10,
  lineHeight: 10,
  font: 'serif',
  weight: 'regular',
  bold: false,
  letterSpacing: 0,
  textAlign: 'left',
  marginTop: mt,
  marginBottom: mb,
  paddingLeft: 0,
  prefix: '',
});
const text = (lines: number, len = 10): Measure => ({
  kind: 'text',
  lines: Array.from({ length: lines }, (_, i) => ({ start: i * len, end: (i + 1) * len, height: 10 })),
  length: lines * len,
});
const p: Block = { k: 'p', r: ['x'] };

describe('lineRanges', () => {
  it('maps reported lines onto the drawn text, tolerating a dropped newline', () => {
    const full = 'Hello world\nsecond line here';
    expect(lineRanges(full, [{ text: 'Hello world', height: 10 }, { text: 'second line here', height: 10 }])).toEqual([
      { start: 0, end: 11, height: 10 },
      { start: 12, end: full.length, height: 10 },
    ]);
  });
});

describe('paginate', () => {
  it('splits a long paragraph across pages at line boundaries, never leaving its last line alone', () => {
    const pages = paginate([p], 100, [text(8)], [look()], 30);
    expect(pages.map((pg) => pg.items.map((i) => [i.b, i.s, i.e, i.top]))).toEqual([
      [[100, 0, 30, true]],
      [[100, 30, 60, true]],
      [[100, 60, 80, true]],
    ]);
    // 7 lines on 3-line pages: 3 + 2 + 2 instead of 3 + 3 + 1.
    expect(paginate([p], 0, [text(7)], [look()], 30).map((pg) => pg.items.map((i) => [i.s, i.e]))).toEqual([[[0, 30]], [[30, 50]], [[50, 70]]]);
  });

  it('drops the top margin at the top of a page and moves a block that does not fit', () => {
    const pages = paginate([p, p, p], 0, [text(2), text(1), text(2)], [look(5), look(5), look(5)], 40);
    // 20 + (5+10) = 35 fits; third needs 5+10 more -> partly on next page
    expect(pages.map((pg) => pg.items.map((i) => [i.b, i.s, i.e]))).toEqual([[[0, 0, 20], [1, 0, 10]], [[2, 0, 20]]]);
  });

  it('puts an image that does not fit on the next page, and caps it to the page', () => {
    const pages = paginate([p, { k: 'img', s: 'a' }], 0, [text(2), { kind: 'box', height: 500 }], [look(), look()], 100);
    expect(pages.length).toBe(2);
    expect(pages[1].items[0]).toMatchObject({ b: 1, h: 100, top: true });
  });

  it('finds the page for a position', () => {
    const pages = paginate([p, p], 10, [text(5), text(5)], [look(), look()], 30);
    expect(pageOf(pages, 10, 0)).toBe(0);
    expect(pageOf(pages, 10, 35)).toBe(1);
    // Pages: 10 [0,30) | 10 [30,50) (11's first line alone would be an orphan) | 11 [0,30) | 11 [30,50)
    expect(pageOf(pages, 11, 0)).toBe(2);
    expect(pageOf(pages, 11, 45)).toBe(3);
  });

  it('does not leave the first line of a paragraph alone at the bottom of a page', () => {
    // Page of 4 lines: 3 used, the next paragraph would put one line there.
    const pages = paginate([p, p], 0, [text(3), text(3)], [look(), look()], 40);
    expect(pages.map((pg) => pg.items.map((i) => [i.b, i.s, i.e]))).toEqual([[[0, 0, 30]], [[1, 0, 30]]]);
    // A one-line paragraph is fine there.
    expect(paginate([p, p], 0, [text(3), text(1)], [look(), look()], 40).length).toBe(1);
  });

  it('a short paragraph that cannot be split without a lone line moves whole', () => {
    // 3 lines, 2 fit: 2 + 1 would leave a widow, 1 + 2 an orphan.
    const pages = paginate([p, p], 0, [text(2), text(3)], [look(), look()], 40);
    expect(pages.map((pg) => pg.items.map((i) => [i.b, i.s, i.e]))).toEqual([[[0, 0, 20]], [[1, 0, 30]]]);
  });

  it('a heading never ends a page: it goes to the next page with its text', () => {
    const h: Block = { k: 'h', l: 2, r: ['Chapter'] };
    // 5 lines of text, then a heading that fits but its text would not.
    const pages = paginate([p, h, p], 0, [text(5), text(1), text(4)], [look(), look(), look()], 70);
    expect(pages.map((pg) => pg.items.map((i) => i.b))).toEqual([[0], [1, 2]]);
    // Room for the heading and two lines: it stays.
    const kept = paginate([p, h, p], 0, [text(4), text(1), text(4)], [look(), look(), look()], 70);
    expect(kept[0].items.map((i) => i.b)).toEqual([0, 1, 2]);
  });

  it('two headings in a row go together', () => {
    const h: Block = { k: 'h', l: 1, r: ['Part'] };
    const pages = paginate([p, h, h, p], 0, [text(4), text(1), text(1), text(3)], [look(), look(), look(), look()], 70);
    expect(pages.map((pg) => pg.items.map((i) => i.b))).toEqual([[0], [1, 2, 3]]);
  });

  it('a picture alone on its page is centred', () => {
    const img: Block = { k: 'img', s: 'a' };
    const pages = paginate([p, img, p], 0, [text(2), { kind: 'box', height: 90 }, text(2)], [look(), look(), look()], 100);
    expect(pages.map((pg) => [pg.items.map((i) => i.b), !!pg.center])).toEqual([
      [[0], false],
      [[1], true],
      [[2], false],
    ]);
  });
});
