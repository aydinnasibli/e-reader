import { describe, expect, it, vi } from 'vitest';
import { BOLD, type Block } from '../src/engine/types';
import { type Hit, findInBlock, fold } from '../src/reader/search';

// search.ts reads chunk files through expo-file-system, which only exists on
// the phone. vi.mock is hoisted above the imports.
vi.mock('expo-file-system', () => ({ File: class {}, Directory: class {}, Paths: {}, FileMode: {} }));

describe('search', () => {
  const block: Block = { k: 'p', r: ['Ёлка и елка. ', ['Ёлки', BOLD], ' зелёные'] };

  it('finds the right place after a Turkish İ (which lowercases to two characters)', () => {
    const text = 'İstanbul and İzmir are big cities';
    expect(fold(text).length).toBe(text.length);
    const hits: Hit[] = [];
    findInBlock({ k: 'p', r: [text] }, 0, fold('izmir'), hits, 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].o).toBe(text.indexOf('İzmir'));
    expect(hits[0].match).toBe('İzmir');
  });

  it('finds words split across style runs (a bold first letter)', () => {
    const hits: Hit[] = [];
    findInBlock({ k: 'p', r: [['T', BOLD], 'he whale surfaced.'] }, 0, fold('the whale'), hits, 10);
    expect(hits.map((h) => h.match)).toEqual(['The whale']);
  });

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

  it('Turkish: dotted and dotless i, capitals or not, all match; accents make no difference', () => {
    const hits = (text: string, query: string) => {
      const out: Hit[] = [];
      findInBlock({ k: 'p', r: [text] }, 0, fold(query.trim()), out, 100);
      return out.map((h) => h.match);
    };
    expect(hits('Işık yandı. Odada ışık vardı.', 'ışık')).toEqual(['Işık', 'ışık']);
    expect(hits('IŞIK', 'ışık')).toEqual(['IŞIK']);
    expect(hits('Odada ışık vardı.', 'Işık')).toEqual(['ışık']);
    expect(hits('İstanbul ve istanbul', 'istanbul')).toEqual(['İstanbul', 'istanbul']);
    // "ILIK" (typed without Turkish letters) finds "ılık" and the heading "ILIK".
    expect(hits('ILIK bir rüzgâr; ılık su.', 'ILIK')).toEqual(['ILIK', 'ılık']);
    expect(hits('Kırmızı güneş', 'kirmizi gunes')).toEqual(['Kırmızı güneş']);
  });

  it('respects the hit limit', () => {
    const hits: Hit[] = [];
    findInBlock(block, 0, 'л', hits, 2);
    expect(hits).toHaveLength(2);
  });
});
