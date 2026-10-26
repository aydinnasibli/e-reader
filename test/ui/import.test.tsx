/// <reference types="jest" />
// Adding books with the picker: each file is copied in with the asynchronous file API (the picker's
// own copy is made on Android's UI thread and froze the app for big books), the same file twice is
// noticed and not added again, files without a book extension are recognised from their bytes, and
// a file the app may not read is told apart from a phone without room. Over memfs.ts.

jest.mock('expo-file-system', () => require('./memfs'));
jest.unmock('@/lib/storage');
const mockPicks: { name: string; uri: string; size?: number }[][] = [];
const mockPicker = jest.fn((_options: unknown) => Promise.resolve({ canceled: false, assets: mockPicks.shift() ?? [] }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: (o: unknown) => mockPicker(o) }));
// Conversion isn't what this tests: it never finishes.
jest.mock('@/engine/ingest', () => ({
  ...jest.requireActual('@/engine/ingest'),
  ingestBook: () => new Promise(() => {}),
}));

import { strToU8, zipSync } from 'fflate';
import { Platform } from 'react-native';
import { getBook, importBooks, updateBook } from '@/lib/library';
import * as memfs from './memfs';

const bytes = (seed: number, n = 200_000) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);
/** Picked files stay where they are: on Android a content:// address of the Downloads provider. */
let picked = 0;
function pick(...files: [string, Uint8Array][]) {
  mockPicks.push(
    files.map(([name, data]) => {
      const uri = `content://com.android.providers.downloads.documents/document/${++picked}`;
      memfs.putForeign(uri, data, { name });
      return { name, uri, size: data.length };
    }),
  );
}
/** The id of the book on the shelf whose original file is `data`. */
const shelfId = (data: Uint8Array) =>
  [...memfs.disk.entries()].find(([k, n]) => k.startsWith('mem://doc/books/') && n.kind === 'file' && n.data.length === data.length && n.data[7] === data[7])![0].split('/')[4];
const cacheLeft = () => [...memfs.disk.entries()].filter(([k, n]) => k.startsWith('mem://cache/') && n.kind === 'file').map(([k]) => k);
const copySync = jest.spyOn(memfs.File.prototype, 'copySync');

beforeAll(() => memfs.resetDisk());
beforeEach(() => copySync.mockClear());

it('the picker makes no copy of its own: each book is copied in without holding up the app', async () => {
  pick(['big.epub', bytes(3)]);
  expect(await importBooks()).toMatchObject({ added: 1 });
  expect(mockPicker).toHaveBeenLastCalledWith(expect.objectContaining({ copyToCacheDirectory: false }));
  // Copied with the asynchronous copy(), not the blocking copySync().
  expect(copySync).not.toHaveBeenCalled();
  expect(memfs.disk.has(`mem://doc/books/${shelfId(bytes(3))}/source.epub`)).toBe(true);
  expect(cacheLeft()).toEqual([]);
});

it('the same book added again is not added twice, and the copy made of it is cleaned up', async () => {
  const moby = bytes(1);
  pick(['moby.epub', moby]);
  expect(await importBooks()).toMatchObject({ added: 1, duplicates: [] });

  // Same file, even under another name; and a different book of the same size.
  pick(['Moby Dick (1).epub', moby], ['other.epub', bytes(2)]);
  const res = await importBooks();
  expect(res.added).toBe(1);
  expect(res.duplicates).toEqual([['Moby Dick (1).epub', 'moby']]);
  expect(cacheLeft()).toEqual([]);
});

it('two copies picked at once: only one is added', async () => {
  const book = bytes(7, 1000);
  pick(['a.fb2', book], ['b.fb2', book]);
  const res = await importBooks();
  expect(res.added).toBe(1);
  expect(res.duplicates.map((d) => d[0])).toEqual(['b.fb2']);
});

it('books added before fingerprints existed are recognised too', async () => {
  const old = bytes(9, 5000);
  pick(['old.txt', old]);
  await importBooks();
  const id = shelfId(old);
  // Pretend it was added by an older version: no fingerprint saved.
  delete (getBook(id) as { fp?: string }).fp;

  pick(['old again.txt', old]);
  const res = await importBooks();
  expect(res.added).toBe(0);
  expect(res.duplicates).toHaveLength(1);
  expect(getBook(id)!.fp).toBeTruthy(); // filled in for next time
});

it('a file without a book extension is recognised from its bytes, like a shared one; other files are skipped', async () => {
  const epub = zipSync({ mimetype: strToU8('application/epub+zip'), 'META-INF/container.xml': strToU8('<container/>') });
  pick(['document', epub], ['page.html', strToU8('<!DOCTYPE html><html><body>Hi</body></html>')]);
  const res = await importBooks();
  expect(res).toMatchObject({ added: 1, skipped: ['page.html'] });
  expect(getBook(shelfId(epub))).toMatchObject({ fileName: 'document.epub', sourceName: 'source.epub', title: 'document' });
  expect(cacheLeft()).toEqual([]);
});

it('a book that failed to prepare is not added again: the one on the shelf offers to try again', async () => {
  const locked = bytes(11, 3000);
  pick(['locked.epub', locked]);
  await importBooks();
  updateBook(shelfId(locked), { status: 'error', error: 'This book is copy-protected (DRM)…' });

  pick(['locked.epub', locked]);
  expect(await importBooks()).toMatchObject({ added: 0, duplicates: [['locked.epub', 'locked']] });
});

it('a file the app isn’t let read (Expo Go on Android: "Missing READ permission") is not blamed on free space', async () => {
  const uri = 'content://com.android.providers.downloads.documents/document/locked-away';
  memfs.putForeign(uri, bytes(13), { denied: true });
  mockPicks.push([{ name: 'alice.epub', uri, size: 200_000 }]);
  expect(await importBooks()).toMatchObject({ added: 0, unreadable: ['alice.epub'], failed: [] });
});

it('no room for a book: it is refused before copying, as not enough space', async () => {
  pick(['huge.epub', bytes(17)]);
  memfs.setFreeSpace(100_000);
  try {
    expect(await importBooks()).toMatchObject({ added: 0, failed: ['huge.epub'], unreadable: [] });
  } finally {
    memfs.setFreeSpace(undefined);
  }
  expect(cacheLeft()).toEqual([]);
});

it('on iPhone the picker hands over a temporary copy of its own: not kept once the book is added', async () => {
  const platform = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  try {
    const uri = 'file:///private/var/mobile/Containers/Data/Application/0A1B/tmp/app-Inbox/Persuasion.epub';
    memfs.putFile(uri, bytes(19, 4000));
    mockPicks.push([{ name: 'Persuasion.epub', uri, size: 4000 }]);
    expect(await importBooks()).toMatchObject({ added: 1 });
    expect(memfs.disk.has(uri)).toBe(false);
  } finally {
    Object.defineProperty(Platform, 'OS', { value: platform, configurable: true });
  }
});
