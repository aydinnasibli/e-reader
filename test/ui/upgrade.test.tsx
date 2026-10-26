/// <reference types="jest" />
// Books converted by an older converter are converted again in the background (ENGINE_VERSION),
// through the real library, storage, converter and annotations over memfs.ts. The old conversion
// here has blocks the new one doesn't (hidden text it kept), so every block number moves: the
// highlights, notes, bookmark and reading place must end up on the same words, a copy of the old
// annotations is kept, the book stays readable as it was until the swap, and a swap or a conversion
// cut short by the app being killed is finished at the next start.

import { strToU8 } from 'fflate';
import { waitFor } from '@testing-library/react-native';

jest.mock('expo-file-system', () => require('./memfs'));
jest.unmock('@/lib/storage');
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

import type { Annotations } from '@/lib/annotations';
import type { Manifest } from '@/engine/types';
import { ENGINE_VERSION } from '@/engine/types';
import { EPUB, ID, OLD_FIRST, dir, expectMarksMoved, newBlock, oldBook, para, put, read } from './oldBook';

const memfs = require('./memfs') as typeof import('./memfs');

const running: (typeof import('@/lib/library'))[] = [];
/** Start the app afresh (only what's on disk), as _layout does. */
function app() {
  jest.resetModules();
  const library = require('@/lib/library') as typeof import('@/lib/library');
  const annotations = require('@/lib/annotations') as typeof import('@/lib/annotations');
  running.push(library);
  return { library, annotations, start: () => library.loadLibrary() };
}
// An earlier "app" mustn't save its library over the next test's disk a moment later.
afterEach(() => running.splice(0).forEach((l) => l.flushLibrary()));

beforeEach(() => jest.restoreAllMocks());

it('a book from an older converter is converted again in the background, its marks and place moved onto the same words', async () => {
  const { annotations: before } = oldBook();
  const a = app();
  a.start();
  await waitFor(() => expect(a.library.getBook(ID)?.engine).toBe(ENGINE_VERSION), { timeout: 15000 });

  expect(read<Manifest>('manifest.json').v).toBe(ENGINE_VERSION);
  // The new conversion's pictures (its cover) came with it.
  expect(memfs.disk.has(`${dir}/img/cover.png`)).toBe(true);
  const after = a.annotations.getAnnotations(ID);
  expectMarksMoved(after, before);
  // Saved too, not just in memory.
  expect(read<Annotations>('annotations.json').highlights.map((h) => h.id).sort()).toEqual(['birds', 'gone', 'ship', 'the']);
  // A copy of the annotations as they were.
  expect(read<Annotations>('annotations.v1.json')).toEqual(before);
  // The reading place: the same paragraph, the same letter; the share of the book worked out again.
  const book = a.library.getBook(ID)!;
  expect(newBlock(book.position!.b)).toBe(para(25));
  expect(book.position!.o).toBe(10);
  expect(book.percent).toBeGreaterThan(0.5);
  expect(book.percent).toBeLessThan(0.75);
  // The old conversion's leftovers and the page numbers worked out for it are gone.
  expect(memfs.disk.has(`${dir}/pages.json`)).toBe(false);
  expect(memfs.disk.has(`${dir}/img/old-only.png`)).toBe(false);
  expect([...memfs.disk.keys()].filter((k) => k.startsWith(`${dir}/next`))).toEqual([]);
  // The book stayed readable throughout: never "processing".
  expect(book.status).toBe('ready');
}, 30000);

it('while the book is open it is read as it was; the new conversion takes over once it is closed', async () => {
  oldBook();
  const a = app();
  a.library.setBookOpen(ID, true);
  a.start();
  // Converted, waiting in next/.
  await waitFor(() => expect(memfs.disk.has(`${dir}/next/manifest.json`)).toBe(true), { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 200));
  expect(read<Manifest>('manifest.json').v).toBe(1);
  expect(read<Annotations>('annotations.json').highlights.find((h) => h.id === 'the')!.b).toBe(OLD_FIRST + 20);
  expect(a.library.getBook(ID)?.engine).not.toBe(ENGINE_VERSION);

  a.library.setBookOpen(ID, false);
  await waitFor(() => expect(a.library.getBook(ID)?.engine).toBe(ENGINE_VERSION), { timeout: 15000 });
  expect(read<Manifest>('manifest.json').v).toBe(ENGINE_VERSION);
}, 30000);

it('killed in the middle of the swap: the next start finishes it before anything reads the book', async () => {
  const { annotations: before } = oldBook();
  const a = app();
  const memNow = require('./memfs') as typeof import('./memfs');
  // The second folder moved into place is where the app dies.
  const move = memNow.Directory.prototype.moveSync;
  let moves = 0;
  jest.spyOn(memNow.Directory.prototype, 'moveSync').mockImplementation(function (this: InstanceType<typeof memNow.Directory>, ...args) {
    if (++moves === 2) throw new Error('process killed');
    return move.apply(this, args);
  });
  a.start();
  await waitFor(() => expect(memfs.disk.has(`${dir}/next/commit.json`)).toBe(true), { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 100));
  jest.restoreAllMocks();
  // Half done: new chunks, old manifest.
  expect(read<Manifest>('manifest.json').v).toBe(1);

  const b = app();
  b.start();
  expect(read<Manifest>('manifest.json').v).toBe(ENGINE_VERSION);
  expect(b.library.getBook(ID)?.engine).toBe(ENGINE_VERSION);
  expectMarksMoved(b.annotations.getAnnotations(ID), before);
  expect(memfs.disk.has(`${dir}/next/commit.json`)).toBe(false);
}, 30000);

it('the moved marks can’t be saved (a full phone): nothing changes, the space goes back, and what is read and marked afterwards is kept when it is done later', async () => {
  const { annotations: before } = oldBook();
  const a = app();
  const memNow = require('./memfs') as typeof import('./memfs');
  // Room for everything but the book's annotations.
  const write = memNow.File.prototype.writeSync;
  let refused = 0;
  jest.spyOn(memNow.File.prototype, 'writeSync').mockImplementation(function (this: InstanceType<typeof memNow.File>, ...args) {
    if (this.uri === `${dir}/annotations.json.tmp`) {
      refused++;
      throw new Error('java.io.IOException: write failed: ENOSPC (No space left on device)');
    }
    return write.apply(this, args);
  });
  jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(() => {});
  a.start();
  await waitFor(() => expect(refused).toBeGreaterThan(0), { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 100));
  jest.restoreAllMocks();
  // Nothing swapped: the old conversion, its marks where they were, on disk and on screen; no plan
  // left to be carried out later on marks that will have changed by then, and the new conversion's
  // space given back.
  expect(read<Manifest>('manifest.json').v).toBe(1);
  expect(read<Annotations>('annotations.json')).toEqual(before);
  expect(a.annotations.getAnnotations(ID)).toEqual(before);
  expect(a.library.getBook(ID)?.engine).not.toBe(ENGINE_VERSION);
  expect([...memfs.disk.keys()].filter((k) => k.startsWith(`${dir}/next`))).toEqual([]);

  // Room again. The person reads on in the old conversion and highlights a word there.
  const s = para(30).indexOf('island');
  a.annotations.addHighlight(ID, { b: OLD_FIRST + 30, s, e: s + 6, color: 'pink', text: 'island' });
  a.library.updateBook(ID, { position: { b: OLD_FIRST + 35, o: 0 }, percent: 0.85 });
  a.library.flushLibrary();
  const now = read<Annotations>('annotations.json');

  // Next start: converted again, from the marks and place as they are now.
  const b = app();
  b.start();
  await waitFor(() => expect(b.library.getBook(ID)?.engine).toBe(ENGINE_VERSION), { timeout: 15000 });
  const after = b.annotations.getAnnotations(ID);
  expectMarksMoved(after, before);
  const pink = after.highlights.find((h) => h.color === 'pink')!;
  expect(newBlock(pink.b).startsWith('Paragraph 30.')).toBe(true);
  expect(newBlock(pink.b).slice(pink.s, pink.e)).toBe('island');
  expect(newBlock(b.library.getBook(ID)!.position!.b)).toBe(para(35));
  // The copy kept is of the annotations just before the swap, with the new highlight.
  expect(read<Annotations>('annotations.v1.json')).toEqual(now);
}, 30000);

it('a plan that couldn’t be carried out, nor removed, isn’t carried out at the next start on marks made since', async () => {
  const { annotations: before } = oldBook();
  const a = app();
  const memNow = require('./memfs') as typeof import('./memfs');
  const write = memNow.File.prototype.writeSync;
  const del = memNow.File.prototype.delete;
  let refused = 0;
  // Saving the moved marks fails (not for space), and so does removing the plan.
  jest.spyOn(memNow.File.prototype, 'writeSync').mockImplementation(function (this: InstanceType<typeof memNow.File>, ...args) {
    if (this.uri === `${dir}/annotations.json.tmp`) {
      refused++;
      throw new Error('java.io.IOException: I/O error');
    }
    return write.apply(this, args);
  });
  jest.spyOn(memNow.File.prototype, 'delete').mockImplementation(function (this: InstanceType<typeof memNow.File>) {
    if (this.uri.startsWith(`${dir}/next/commit.json`)) throw new Error('java.io.IOException: I/O error');
    return del.apply(this);
  });
  jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(() => {});
  a.start();
  await waitFor(() => expect(refused).toBeGreaterThan(0), { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 100));
  jest.restoreAllMocks();
  expect(memfs.disk.has(`${dir}/next/commit.json`)).toBe(true);
  // The person reads on and highlights a word in the old conversion.
  const s = para(30).indexOf('island');
  a.annotations.addHighlight(ID, { b: OLD_FIRST + 30, s, e: s + 6, color: 'pink', text: 'island' });
  a.library.updateBook(ID, { position: { b: OLD_FIRST + 35, o: 0 }, percent: 0.85 });
  a.library.flushLibrary();

  const b = app();
  b.start();
  await waitFor(() => expect(b.library.getBook(ID)?.engine).toBe(ENGINE_VERSION), { timeout: 15000 });
  const after = b.annotations.getAnnotations(ID);
  expectMarksMoved(after, before);
  expect(after.highlights.some((h) => h.color === 'pink')).toBe(true);
  expect(newBlock(b.library.getBook(ID)!.position!.b)).toBe(para(35));
}, 30000);

it('no room for a second conversion beside the first: not started (the book stays as it is)', async () => {
  oldBook();
  const a = app();
  const memNow = require('./memfs') as typeof import('./memfs');
  const write = memNow.File.prototype.writeSync;
  const written: string[] = [];
  jest.spyOn(memNow.File.prototype, 'writeSync').mockImplementation(function (this: InstanceType<typeof memNow.File>, ...args) {
    if (this.uri.startsWith(`${dir}/next/`)) written.push(this.uri);
    return write.apply(this, args);
  });
  memfs.setFreeSpace(1000);
  try {
    a.start();
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    memfs.setFreeSpace(undefined);
    jest.restoreAllMocks();
  }
  // Not even begun: nothing written only to fail for space part way.
  expect(written).toEqual([]);
  expect([...memfs.disk.keys()].filter((k) => k.startsWith(`${dir}/next`))).toEqual([]);
  expect(read<Manifest>('manifest.json').v).toBe(1);
  expect(a.library.getBook(ID)?.status).toBe('ready');
  expect(a.library.getBook(ID)?.upgradeFailed).toBeUndefined();
});

it('a picture that can’t be written: the new conversion isn’t put in place of the whole one', async () => {
  oldBook();
  const a = app();
  const memNow = require('./memfs') as typeof import('./memfs');
  const write = memNow.File.prototype.writeSync;
  jest.spyOn(memNow.File.prototype, 'writeSync').mockImplementation(function (this: InstanceType<typeof memNow.File>, ...args) {
    if (this.uri.startsWith(`${dir}/next/img/`)) throw new Error('java.io.IOException: write failed: ENOSPC (No space left on device)');
    return write.apply(this, args);
  });
  a.start();
  await new Promise((r) => setTimeout(r, 1500));
  jest.restoreAllMocks();
  expect(read<Manifest>('manifest.json').v).toBe(1);
  expect([...memfs.disk.keys()].filter((k) => k.startsWith(`${dir}/next`))).toEqual([]);
  // Not the book's fault: tried again (with room) next time.
  expect(a.library.getBook(ID)?.upgradeFailed).toBeUndefined();
}, 30000);

it('a backup being made: no new conversion is swapped in until it is done, so it is all of one conversion', async () => {
  oldBook();
  const a = app();
  a.library.setBookOpen(ID, true);
  a.start();
  await waitFor(() => expect(memfs.disk.has(`${dir}/next/manifest.json`)).toBe(true), { timeout: 15000 });
  // While a backup is being made, the book is closed, which would swap its new conversion in.
  await a.library.withoutSwaps(async () => {
    a.library.setBookOpen(ID, false);
    await new Promise((r) => setTimeout(r, 1500));
    expect(read<Manifest>('manifest.json').v).toBe(1);
    expect(a.library.getBook(ID)?.engine).not.toBe(ENGINE_VERSION);
  });
  // Done: swapped in now.
  await waitFor(() => expect(a.library.getBook(ID)?.engine).toBe(ENGINE_VERSION), { timeout: 15000 });
  // A backup names the converter version of the very conversion its marks were read from.
  const backup = require('@/lib/backup') as typeof import('@/lib/backup');
  const made = await backup.createBackup();
  expect(made.books[0]).toMatchObject({ engine: ENGINE_VERSION });
  expect(made.books[0].anchors?.hthe?.before).toContain('calm and the night was long, and');
}, 30000);

it('a conversion cut short (the app was killed) is started again at the next start', async () => {
  const { annotations: before } = oldBook();
  // What was written before the app died: a chunk, no manifest.
  put('next/c/0.json', { b: [{ k: 'p', r: ['half'] }] });
  const a = app();
  a.start();
  await waitFor(() => expect(a.library.getBook(ID)?.engine).toBe(ENGINE_VERSION), { timeout: 15000 });
  expectMarksMoved(a.annotations.getAnnotations(ID), before);
}, 30000);

it('converting it again kept closing the app: it keeps the conversion it has and isn’t tried again', async () => {
  oldBook({ attempts: 2 });
  memfs.putFile(`${dir}/next/c/0.json`, strToU8('{"b":[]}'));
  const a = app();
  a.start();
  await new Promise((r) => setTimeout(r, 300));
  expect(a.library.getBook(ID)).toMatchObject({ status: 'ready', upgradeFailed: ENGINE_VERSION, attempts: undefined });
  expect(read<Manifest>('manifest.json').v).toBe(1);
  expect([...memfs.disk.keys()].filter((k) => k.startsWith(`${dir}/next`))).toEqual([]);
});

it('"Try again" on a damaged book moves its marks the same way, even from chunks that can no longer be read', async () => {
  const { annotations: before } = oldBook({ engine: ENGINE_VERSION });
  // The chunk with paragraphs 24-38 is damaged: those marks are found from their saved text alone.
  memfs.putFile(`${dir}/c/2.json`, strToU8('{"b":[{"k":"p","r":['));
  const a = app();
  a.start();
  a.library.reprocessBook(ID);
  await waitFor(() => expect(a.library.getBook(ID)?.status).toBe('ready'), { timeout: 15000 });
  await waitFor(() => expect(a.library.getBook(ID)?.marksWaiting).toBeFalsy(), { timeout: 15000 });
  expectMarksMoved(a.annotations.getAnnotations(ID), before);
  expect(read<Annotations>('annotations.v1.json')).toEqual(before);
}, 30000);

it('a book whose file an earlier version lost keeps its conversion and says so once; adding the file again repairs it', async () => {
  // Added by "Open with", which noted the file's fingerprint and then lost the file.
  const { fingerprintOf } = require('@/lib/fingerprint') as typeof import('@/lib/fingerprint');
  const fp = fingerprintOf({ size: EPUB.length, read: (o: number, n: number) => EPUB.slice(o, o + n) });
  const { annotations: before } = oldBook({ fp });
  memfs.disk.delete(`${dir}/source.epub`);
  const a = app();
  const alert = jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(() => {});
  a.start();
  await waitFor(() => expect(a.library.getBook(ID)?.sourceMissing).toBe(true));
  await waitFor(() => expect(alert).toHaveBeenCalledWith('A book needs its file again', expect.stringContaining('The Sea')));
  expect(a.library.getBook(ID)?.status).toBe('ready');
  // Said once: not again at the next start.
  const again = app();
  const alertAgain = jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(() => {});
  again.start();
  await new Promise((r) => setTimeout(r, 200));
  expect(alertAgain).not.toHaveBeenCalled();

  // Picked again: the book gets its file back and then its new conversion, with its marks.
  memfs.putFile('mem://cache/picked/sea again.epub', EPUB);
  (require('expo-document-picker').getDocumentAsync as jest.Mock).mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'mem://cache/picked/sea again.epub', name: 'sea again.epub', size: EPUB.length }],
  });
  expect(await again.library.importBooks()).toMatchObject({ added: 1, duplicates: [] });
  expect(again.library.getBooks()).toHaveLength(1);
  await waitFor(() => expect(again.library.getBook(ID)?.engine).toBe(ENGINE_VERSION), { timeout: 15000 });
  expect(again.library.getBook(ID)?.sourceMissing).toBeUndefined();
  expectMarksMoved(again.annotations.getAnnotations(ID), before);
}, 30000);

// ---------- marks waiting for a book (marks.json) ----------

describe('marks waiting for a book', () => {
  /** A backup's entry for the book: one highlight on `word` of paragraph p, made on another conversion. */
  function saved(id: string, p: number, word: string): import('@/lib/restore').SavedBook {
    const s = para(p).indexOf(word);
    return { fp: 'x', title: 'The Sea', author: '', engine: 1, collections: [], annotations: { highlights: [{ id, b: 999, s, e: s + word.length, color: 'blue', text: word, createdAt: 5 }], bookmarks: [] } };
  }

  it('marks queued while earlier ones are being placed are placed too', async () => {
    // A book already on this converter: nothing is converted, only marks are placed.
    oldBook({ engine: ENGINE_VERSION });
    const a = app();
    const restore = require('@/lib/restore') as typeof import('@/lib/restore');
    a.start();
    await new Promise((r) => setTimeout(r, 50));
    a.library.queueMarks(ID, restore.savedMarkSet(saved('fromA', 30, 'island')));
    // A moment later (placing is under way) a second backup is restored.
    await Promise.resolve();
    a.library.queueMarks(ID, restore.savedMarkSet(saved('fromB', 31, 'island')));
    await waitFor(() => expect(a.library.getBook(ID)?.marksWaiting).toBeFalsy(), { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 200));
    const ids = a.annotations.getAnnotations(ID).highlights.map((h) => h.id);
    expect(ids).toEqual(expect.arrayContaining(['fromA', 'fromB']));
  }, 30000);

  it('marks once placed don’t come back from an old copy of the list: a highlight removed since stays removed', async () => {
    oldBook({ engine: ENGINE_VERSION });
    const a = app();
    const restore = require('@/lib/restore') as typeof import('@/lib/restore');
    a.start();
    await new Promise((r) => setTimeout(r, 50));
    // Two sets wait together (the book is being prepared), so marks.json gets a saved copy.
    a.library.updateBook(ID, { status: 'processing' });
    a.library.queueMarks(ID, restore.savedMarkSet(saved('fromA', 30, 'island')));
    a.library.queueMarks(ID, restore.savedMarkSet(saved('fromB', 31, 'island')));
    expect(memfs.disk.has(`${dir}/marks.json.bak`)).toBe(true);
    a.library.reprocessBook(ID);
    await waitFor(() => expect(a.library.getBook(ID)?.status).toBe('ready'), { timeout: 15000 });
    await waitFor(() => expect(a.library.getBook(ID)?.marksWaiting).toBeFalsy(), { timeout: 15000 });
    expect(a.annotations.getAnnotations(ID).highlights.map((h) => h.id)).toContain('fromA');
    expect([...memfs.disk.keys()].filter((k) => k.startsWith(`${dir}/marks.json`))).toEqual([]);
    a.annotations.removeHighlight(ID, 'fromA');
    // Later another backup is restored for this book.
    a.library.queueMarks(ID, restore.savedMarkSet(saved('fromC', 32, 'island')));
    await waitFor(() => expect(a.library.getBook(ID)?.marksWaiting).toBeFalsy(), { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 200));
    const ids = a.annotations.getAnnotations(ID).highlights.map((h) => h.id);
    expect(ids).toContain('fromC');
    expect(ids).not.toContain('fromA');
  }, 30000);

  it('placing the same marks twice (cut short and done again) adds no second copy of a split highlight', async () => {
    const { withMoved } = require('@/lib/remap') as typeof import('@/lib/remap');
    const h = { id: 'x', b: 1, s: 0, e: 5, color: 'yellow' as const, text: 'Alpha beta', createdAt: 1 };
    const set = { merge: false, highlights: [h], bookmarks: [], anchors: {} };
    const moved = { highlights: { x: [{ ...h, b: 2, e: 5, text: 'Alpha' }, { ...h, id: 'x~1', b: 3, s: 0, e: 4, text: 'beta' }] }, bookmarks: {}, unsure: 0 };
    const once = withMoved({ highlights: [h], bookmarks: [] }, set, moved);
    const twice = withMoved(once, set, moved);
    expect(twice.highlights.map((x) => x.id)).toEqual(['x', 'x~1']);
    const merged = withMoved(once, { ...set, merge: true }, moved);
    expect(merged.highlights.map((x) => x.id)).toEqual(['x', 'x~1']);
  });
});
