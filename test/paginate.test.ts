import { describe, expect, it } from 'vitest';
import type { Block } from '../src/engine/types';
import type { Look } from '../src/reader/look';
import { type Measure, lineRanges, pageOf, paginate } from '../src/reader/paginate';

const look = (mt = 0, mb = 0): Look => ({ fontSize: 10, lineHeight: 10, textAlign: 'left', marginTop: mt, marginBottom: mb, paddingLeft: 0, prefix: '' });
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
  it('splits a long paragraph across pages at line boundaries', () => {
    const pages = paginate([p], 100, [text(7)], [look()], 30);
    expect(pages.map((pg) => pg.items.map((i) => [i.b, i.s, i.e, i.top]))).toEqual([
      [[100, 0, 30, true]],
      [[100, 30, 60, true]],
      [[100, 60, 70, true]],
    ]);
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
    expect(pageOf(pages, 11, 0)).toBe(1);
    expect(pageOf(pages, 11, 45)).toBe(3);
  });
});
