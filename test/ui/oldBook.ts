/// <reference types="jest" />
// A book as an older version of the app left it on the phone (converted by converter version 1,
// with highlights, a note, a bookmark and a reading place), for the tests of converting books again
// and of restoring backups made from such a conversion. Over memfs.ts.

import { strToU8, zipSync } from 'fflate';
import type { Annotations, Highlight } from '@/lib/annotations';
import type { Block, ChunkFile, Manifest } from '@/engine/types';
import { blockLength, blockText } from '@/engine/types';

import * as memfs from './memfs';

/** Paragraph i: every one has "the" in it several times, so a highlighted "the" can only be found by what's around it. */
export const para = (i: number) =>
  i === 12 ? 'Paragraph 12. Kuşlar uçtu, ağaçlar sallandı.' : `Paragraph ${i}. The sea was calm and the night was long, and the ship went on past island number ${i * 7}.`;
export const PARAS = 40;
/** A tiny PNG, the book's cover: written when the book is converted. */
const COVER = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
export const EPUB = zipSync({
  mimetype: strToU8('application/epub+zip'),
  'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OEBPS/c.opf"/></rootfiles></container>'),
  'OEBPS/c.opf': strToU8(
    '<package><metadata><dc:title>The Sea</dc:title><dc:creator>A. Sailor</dc:creator><dc:language>en</dc:language><meta name="cover" content="cov"/></metadata>' +
      '<manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="cov" href="cover.png" media-type="image/png"/></manifest>' +
      '<spine><itemref idref="a"/></spine></package>',
  ),
  'OEBPS/a.xhtml': strToU8(`<html><body><h1>Chapter One</h1>${Array.from({ length: PARAS }, (_, i) => `<p>${para(i)}</p>`).join('')}</body></html>`),
  'OEBPS/cover.png': COVER,
});

export const ID = 'sea';
export const dir = `mem://doc/books/${ID}`;
export const put = (path: string, value: unknown) => memfs.putFile(`${dir}/${path}`, strToU8(typeof value === 'string' ? value : JSON.stringify(value)));
export const read = <T,>(path: string): T => JSON.parse(new memfs.File(`${dir}/${path}`).textSync()) as T;

/**
 * The book as an older version left it: a conversion (v1) that kept five paragraphs of hidden
 * text after the heading, so paragraph i is block 6 + i there; one paragraph stored decomposed (NFD).
 */
export function oldConversion(): Block[] {
  const hidden = Array.from({ length: 5 }, (_, i): Block => ({ k: 'p', r: [`Hidden page-list entry ${i} that only the old converter kept.`] }));
  const paras = Array.from({ length: PARAS }, (_, i): Block => ({ k: 'p', r: [i === 12 ? para(i).normalize('NFD') : para(i)] }));
  return [{ k: 'h', l: 1, r: ['Chapter One'] }, ...hidden, ...paras];
}
export const OLD_FIRST = 6; // paragraph 0's block in the old conversion

/** Lay the old book on the "phone": its file, old conversion, marks, page-number cache and library entry. */
export function oldBook(extra: Record<string, unknown> = {}) {
  memfs.resetDisk();
  const blocks = oldConversion();
  const per = 15;
  const chunks: [number, number][] = [];
  let chars = 0;
  for (let i = 0; i < blocks.length; i += per) {
    chunks.push([i, chars]);
    put(`c/${chunks.length - 1}.json`, { b: blocks.slice(i, i + per) } satisfies ChunkFile);
    for (const b of blocks.slice(i, i + per)) chars += blockLength(b);
  }
  const manifest: Manifest = { v: 1, format: 'epub', title: 'The Sea', author: 'A. Sailor', totalBlocks: blocks.length, totalChars: chars, chunks, toc: [{ t: 'Chapter One', l: 0, b: 0 }], images: {} };
  put('manifest.json', manifest);
  memfs.putFile(`${dir}/source.epub`, EPUB);
  memfs.putFile(`${dir}/img/old-only.png`, Uint8Array.from([1, 2, 3]));
  put('pages.json', { old: 'page numbers' });
  const at = (p: number, word: string, nth = 0) => {
    const t = blockText(blocks[OLD_FIRST + p]);
    let s = -1;
    for (let k = 0; k <= nth; k++) s = t.indexOf(word, s + 1);
    return { b: OLD_FIRST + p, s, e: s + word.length, text: t.slice(s, s + word.length) };
  };
  const hl = (id: string, p: number, word: string, nth = 0, more: Partial<Highlight> = {}): Highlight => ({ id, ...at(p, word, nth), color: 'yellow', createdAt: 1, ...more });
  const annotations: Annotations = {
    highlights: [
      hl('the', 20, 'the', 1, { note: 'mine', color: 'green' }),
      hl('ship', 33, `island number ${33 * 7}`),
      hl('birds', 12, 'ağaçlar'.normalize('NFD')),
      // Text only the old conversion has: it can't be found, but it isn't dropped.
      { id: 'gone', b: 3, s: 0, e: 6, text: 'Hidden', color: 'blue', createdAt: 1 },
    ],
    bookmarks: [{ id: 'bm', b: OLD_FIRST + 28, o: 0, snippet: para(28), createdAt: 1 }],
  };
  put('annotations.json', annotations);
  const entry = { id: ID, title: 'The Sea', author: 'A. Sailor', format: 'epub', fileName: 'sea.epub', sourceName: 'source.epub', size: EPUB.length, addedAt: 1, openedAt: 2, status: 'ready', progress: 1, position: { b: OLD_FIRST + 25, o: 10 }, percent: 0.6, ...extra };
  memfs.putFile('mem://doc/library.json', strToU8(JSON.stringify([entry])));
  return { annotations, manifest };
}

/** The new conversion's text of block b. */
export function newBlock(b: number): string {
  const m = read<Manifest>('manifest.json');
  let c = 0;
  while (c + 1 < m.chunks.length && m.chunks[c + 1][0] <= b) c++;
  return blockText(read<ChunkFile>(`c/${c}.json`).b[b - m.chunks[c][0]]);
}

/** Every mark is on the same words as before, in the same paragraph. */
export function expectMarksMoved(a: Annotations, before: Annotations) {
  for (const h of before.highlights.filter((x) => x.id !== 'gone')) {
    const now = a.highlights.find((x) => x.id === h.id)!;
    expect(now).toBeTruthy();
    expect(newBlock(now.b).slice(now.s, now.e).normalize('NFC')).toBe(h.text.normalize('NFC'));
    const paragraph = /^Paragraph \d+\./.exec(oldConversion()[h.b].r![0] as string)![0];
    expect(newBlock(now.b).startsWith(paragraph)).toBe(true);
  }
  const the = a.highlights.find((x) => x.id === 'the')!;
  expect(the).toMatchObject({ note: 'mine', color: 'green' });
  // The second "the" of paragraph 20, not the first, nor one in another paragraph.
  expect(the.s).toBe(para(20).indexOf('the', para(20).indexOf('the') + 1));
  // Not found anywhere: still there, at about the same place.
  const gone = a.highlights.find((x) => x.id === 'gone')!;
  expect(gone.e).toBeGreaterThan(gone.s);
  expect(newBlock(a.bookmarks[0].b)).toBe(para(28));
  expect(a.bookmarks[0].o).toBe(0);
}

