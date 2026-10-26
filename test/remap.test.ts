// Marks found again on another conversion of their book (remap.ts): by their
// text and the text around them, near where they were, then anywhere; never
// dropped.

import { describe, expect, it } from 'vitest';
import type { Block } from '../src/engine/types';
import { blockLength } from '../src/engine/types';
import { type Conversion, anchorsOn, comparable, locate, moveMarks, ownMarks, placeHighlight, snippetAt, withMoved } from '../src/lib/remap';

/** A conversion of these paragraphs, `per` blocks to a chunk. */
function conversion(paras: string[], per = 3): Conversion & { blocks: Block[] } {
  const blocks: Block[] = paras.map((p) => (p === '<img>' ? { k: 'img', s: 'a.png' } : { k: 'p', r: [p] }));
  const chunks: [number, number][] = [];
  let chars = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (i % per === 0) chunks.push([i, chars]);
    chars += blockLength(blocks[i]);
  }
  return {
    blocks,
    chunks,
    totalBlocks: blocks.length,
    totalChars: chars,
    read: async (c) => blocks.slice(chunks[c][0], c + 1 < chunks.length ? chunks[c + 1][0] : blocks.length),
  };
}

const filler = (n: number) => Array.from({ length: n }, (_, i) => `Filler paragraph ${i} where the sea was calm and the night was long.`);
const text = (conv: { blocks: Block[] }, b: number, s: number, e: number) => (conv.blocks[b].r![0] as string).slice(s, e);

describe('moving marks to a new conversion', () => {
  it('a highlight lands on the same words when blocks were added and dropped before it', async () => {
    const story = 'He kissed her on the cheek and the night went on.';
    const old = conversion([...filler(30), story, ...filler(30)]);
    // The new conversion drops 10 paragraphs of hidden text and adds a contents page.
    const neu = conversion(['Contents', 'Chapter One', ...filler(20), story, ...filler(30)]);
    const s = story.indexOf('the cheek');
    const anchors = await anchorsOn(old, [{ key: 'h', b: 30, o: s, end: s + 3, text: 'the' }]);
    const at = (await locate(neu, anchors)).h;
    expect(at).toMatchObject({ found: true, b: 22, o: s, endB: 22, endO: s + 3 });
    // "the" is everywhere: the words around it decided which one.
    const [h] = await placeHighlight({ id: 'h', b: 30, s, e: s + 3, text: 'the', note: 'mine' }, at, neu);
    expect(h).toEqual({ id: 'h', b: 22, s, e: s + 3, text: 'the', note: 'mine' });
  });

  it('a highlight split across two paragraphs by the new conversion becomes two, the note staying with the first', async () => {
    const old = conversion([...filler(5), 'Alpha beta. Gamma delta.', ...filler(5)]);
    const neu = conversion([...filler(5), 'Alpha beta.', 'Gamma delta.', ...filler(5)]);
    const anchors = await anchorsOn(old, [{ key: 'h', b: 5, o: 6, end: 17, text: 'beta. Gamma' }]);
    const at = (await locate(neu, anchors)).h;
    const parts = await placeHighlight({ id: 'h', b: 5, s: 6, e: 17, text: 'beta. Gamma', note: 'n' }, at, neu);
    // The second piece's id is the same however often it is placed.
    expect(parts).toEqual([
      { id: 'h', b: 5, s: 6, e: 11, text: 'beta.', note: 'n' },
      { id: 'h~1', b: 6, s: 0, e: 5, text: 'Gamma' },
    ]);
  });

  it('decomposed letters, soft hyphens and spacing don’t stop a mark from being found', async () => {
    const old = conversion([...filler(4), 'Kuşlar  ve ağaç­lar.'.normalize('NFD'), ...filler(4)]);
    const neu = conversion([...filler(4), 'Kuşlar ve ağaçlar.', ...filler(4)]);
    const t = old.blocks[4].r![0] as string;
    const s = t.indexOf('ağa'.normalize('NFD'));
    const anchors = await anchorsOn(old, [{ key: 'h', b: 4, o: s, end: t.length - 1, text: t.slice(s, -1) }]);
    const at = (await locate(neu, anchors)).h;
    expect(at.found).toBe(true);
    expect(text(neu, at.b, at.o, at.endO)).toBe('ağaçlar');
  });

  it('the reading place and a bookmark are found by the text from where they are', async () => {
    const old = conversion([...filler(40), 'The storm came at dawn, and the masts broke one by one.', ...filler(40)]);
    const neu = conversion([...filler(10), 'The storm came at dawn, and the masts broke one by one.', ...filler(40)]);
    const anchors = await anchorsOn(old, [{ key: 'place', b: 40, o: 4 }]);
    expect(anchors.place.text.startsWith('storm came at dawn')).toBe(true);
    expect(await locate(neu, anchors)).toMatchObject({ place: { b: 10, o: 4, found: true } });
  });

  it('text that changed case or punctuation is still found, loosely', async () => {
    const old = conversion([...filler(8), 'CHAPTER ONE — The Beginning', ...filler(8)]);
    const neu = conversion([...filler(8), 'Chapter One: the beginning', ...filler(8)]);
    const anchors = await anchorsOn(old, [{ key: 'h', b: 8, o: 0, end: 27, text: 'CHAPTER ONE — The Beginning' }]);
    expect((await locate(neu, anchors)).h).toMatchObject({ found: true, b: 8, o: 0, endO: 26 });
  });

  it('a mark whose text is gone stays at the best estimate: never dropped', async () => {
    const old = conversion([...filler(20), 'A sentence the new version no longer has.', ...filler(20)]);
    const neu = conversion([...filler(20), ...filler(20)]);
    const anchors = await anchorsOn(old, [{ key: 'h', b: 20, o: 2, end: 10, text: 'sentence' }]);
    const at = (await locate(neu, anchors)).h;
    expect(at.found).toBe(false);
    expect(at.b).toBeGreaterThanOrEqual(18);
    expect(at.b).toBeLessThanOrEqual(21);
    const [h] = await placeHighlight({ id: 'h', b: 20, s: 2, e: 10, text: 'sentence' }, at, neu);
    expect(h.e).toBeGreaterThan(h.s);
  });

  it('without the old conversion (a backup), its block number is the estimate and the saved text finds it', async () => {
    const neu = conversion([...filler(3), 'Call me Ishmael.', ...filler(30), 'Call me Ishmael.', ...filler(3)]);
    const anchors = await anchorsOn(null, [
      { key: 'early', b: 2, o: 0, end: 4, text: 'Call' },
      { key: 'late', b: 35, o: 0, end: 4, text: 'Call' },
      { key: 'bm', b: 34, o: 0, fallback: 'Call me Ishmael.' },
    ]);
    const at = await locate(neu, anchors);
    expect(at.early).toMatchObject({ found: true, b: 3, o: 0 });
    expect(at.late).toMatchObject({ found: true, b: 34, o: 0 });
    expect(at.bm).toMatchObject({ found: true, b: 34 });
  });

  it('reads a chunk at a time between pauses, so the screen keeps drawing while marks are found', async () => {
    // 64 chunks that all changed a little (quotes): nothing is found exactly, the whole book is gone through twice.
    const p = (i: number) => `Paragraf ${i}. Kuşlar uçtu, ağaçlar sallandı; gün ışığı İstanbul’un üzerine düştü ve şehir uyandı, ${i * 7}. `.repeat(3);
    const paras = Array.from({ length: 64 * 20 }, (_, i) => p(i));
    const old = conversion(paras, 20);
    const neu = conversion(paras.map((t) => t.replace(/’/g, "'").replace(/;/g, ',')), 20);
    const marks = Array.from({ length: 40 }, (_, k) => ({ key: `h${k}`, b: k * 31, o: 10, end: 40, text: paras[k * 31].slice(10, 40) }));
    const anchors = await anchorsOn(old, marks);
    let reads = 0;
    let most = 0;
    const counted = { ...neu, read: (c: number) => (reads++, neu.read(c)) };
    await locate(counted, anchors, async () => {
      most = Math.max(most, reads);
      reads = 0;
    });
    expect(most).toBeLessThanOrEqual(1);
  });

  it('a moved bookmark’s snippet is the new conversion’s text where it is now (a garbled old text isn’t kept)', async () => {
    // The old conversion read a windows-1254 book as windows-1252: Turkish letters came out as �.
    const garbled = 'Onları birbirinden ay\uFFFDrm\uFFFDyordu, dedi yaşlı adam, ve kapıyı kapattı.';
    const right = 'Onları birbirinden ayırmıyordu, dedi yaşlı adam, ve kapıyı kapattı.';
    const old = conversion([...filler(10), garbled, ...filler(10)]);
    const neu = conversion([...filler(10), right, ...filler(10)]);
    const bookmarks = [{ id: 'bm', b: 10, o: 21, snippet: snippetAt(garbled, 21), createdAt: 1 }];
    expect(bookmarks[0].snippet.startsWith('ay\uFFFDrm')).toBe(true);
    const set = await ownMarks(old, { highlights: [], bookmarks }, undefined);
    const moved = await moveMarks(set, neu);
    expect(moved.bookmarks.bm).toMatchObject({ b: 10, snippet: snippetAt(right, moved.bookmarks.bm.o) });
    expect(moved.bookmarks.bm.snippet).toContain('ayırmıyordu');
    // And so it is saved: the book's bookmark gets the new snippet with its new place.
    const after = withMoved({ highlights: [], bookmarks }, set, moved);
    expect(after.bookmarks[0].snippet).toBe(moved.bookmarks.bm.snippet);
  });

  it('snippets start at a word and are at most 140 characters, spaces collapsed (as the reader makes them)', () => {
    const t = 'The  sea was calm\nand the night ' + 'was long '.repeat(30);
    expect(snippetAt(t, 6)).toBe(snippetAt(t, 5));
    expect(snippetAt(t, 6).startsWith('sea was calm and the night')).toBe(true);
    expect(snippetAt(t, 0).length).toBeLessThanOrEqual(140);
  });

  it('compares text composed, without soft hyphens, with spaces collapsed', () => {
    expect(comparable('  a­b   c\n\nd  ')).toBe('ab c d');
    expect(comparable('kuş'.normalize('NFD'))).toBe('kuş');
    expect(comparable('İSTANBUL’da!', true)).toBe('istanbulda');
  });
});
