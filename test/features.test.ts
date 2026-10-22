import { describe, expect, it, vi } from 'vitest';
import { BOLD, type Block } from '../src/engine/types';
import { applyMarks } from '../src/reader/marks';
import { type Hit, findInBlock, fold } from '../src/reader/search';

// search.ts reads chunk files through expo-file-system, which only exists on
// the phone. vi.mock is hoisted above the imports.
vi.mock('expo-file-system', () => ({ File: class {}, Directory: class {}, Paths: {}, FileMode: {} }));

describe('applyMarks', () => {
  it('splits styled runs at highlight edges and keeps styles', () => {
    const segs = applyMarks(['Hello ', ['big', BOLD], ' world'], [{ s: 4, e: 10, color: 'Y' }], 0);
    expect(segs).toEqual([
      { text: 'Hell', bits: 0, bg: undefined },
      { text: 'o ', bits: 0, bg: 'Y' },
      { text: 'big', bits: BOLD, bg: 'Y' },
      { text: ' ', bits: 0, bg: 'Y' },
      { text: 'world', bits: 0, bg: undefined },
    ]);
  });

  it('shifts marks for the indent prefix and for a sliced page range', () => {
    // Drawn text is "  abcdef" (2-char indent); the page shows drawn [4, 8) = "cdef".
    const segs = applyMarks(['cdef'], [{ s: 3, e: 5, color: 'Y' }], 2 - 4);
    expect(segs).toEqual([
      { text: 'c', bits: 0, bg: undefined },
      { text: 'de', bits: 0, bg: 'Y' },
      { text: 'f', bits: 0, bg: undefined },
    ]);
  });

  it('leaves text alone without marks', () => {
    expect(applyMarks(['a', ['b', BOLD]], undefined, 0)).toEqual([
      { text: 'a', bits: 0 },
      { text: 'b', bits: BOLD },
    ]);
  });
});

describe('search', () => {
  const block: Block = { k: 'p', r: ['Ёлка и елка. ', ['Ёлки', BOLD], ' зелёные'] };

  it('folds case and ё without changing offsets', () => {
    expect(fold('ЁлКа')).toBe('елка');
    expect(fold('ЁлКа').length).toBe(4);
  });

  it('finds every match across styled runs, with offsets into the block', () => {
    const hits: Hit[] = [];
    findInBlock(block, 7, fold('ёлк'), hits, 100);
    expect(hits.map((h) => [h.b, h.o, h.match])).toEqual([
      [7, 0, 'Ёлк'],
      [7, 7, 'елк'],
      [7, 13, 'Ёлк'],
    ]);
    expect(hits[1].before).toBe('Ёлка и ');
  });

  it('respects the hit limit', () => {
    const hits: Hit[] = [];
    findInBlock(block, 0, 'л', hits, 2);
    expect(hits).toHaveLength(2);
  });
});
