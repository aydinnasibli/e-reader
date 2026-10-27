/// <reference types="jest" />
// "Open with" on Android and "Open in" on iPhone: a book file shared from another app is recognised
// from its bytes, copied, added (or found on the shelf) and opened. Over the in-memory file system
// that behaves like expo-file-system where it matters (memfs.ts): a File that was moved points where
// it went, so tidying up "the copy" after adding it would delete the book's own file.

import { strToU8, zipSync } from 'fflate';

const mockPush = jest.fn();
const mockReplace = jest.fn();
/** The screen showing (the root layout's usePathname()). */
let mockPath = '/';

jest.mock('expo-file-system', () => require('./memfs'));
jest.unmock('@/lib/storage');
jest.mock('expo-document-picker', () => ({ getDocumentAsync: () => Promise.resolve({ canceled: true, assets: [] }) }));
jest.mock('expo-router', () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), replace: (...a: unknown[]) => mockReplace(...a) },
  usePathname: () => mockPath,
}));
// Conversion isn't what this tests: it opens the book's file, as the real one does, and never finishes.
jest.mock('@/engine/ingest', () => ({
  ...jest.requireActual('@/engine/ingest'),
  ingestBook: () => new Promise(() => {}),
}));

import { act, renderHook } from '@testing-library/react-native';
import { Alert, Platform } from 'react-native';
import { redirectSystemPath } from '@/app/+native-intent';
import { deleteBook, getBook, importSharedFile, sourceFile, updateBook } from '@/lib/library';
import { openSharedFile, useAddingSharedFile, useSharedFileNavigation } from '@/lib/openWith';
import * as memfs from './memfs';

const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
const makeEpub = (text: string) =>
  zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<container/>'),
    'OEBPS/a.xhtml': strToU8('<p>' + text.repeat(50) + '</p>'),
  });
const epub = makeEpub('Call me Ishmael. ');
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0]);
let shares = 0;
/**
 * Another app shares a file: a content:// URI (or a file:// one, when `from` says so), ending in
 * `name` (WhatsApp: often just an id), its provider reporting `reported` as its name. Chat apps'
 * files can only be read from start to end.
 */
function share(data: Uint8Array, name: string, { from = 'com.whatsapp.provider.media/item', reported = name, pipe = false } = {}) {
  const base = from.includes('://') ? from : `content://${from}`;
  const uri = `${base}/${++shares}/${encodeURIComponent(name)}`;
  if (uri.startsWith('file:')) memfs.putFile(uri, data);
  else memfs.putForeign(uri, data, { name: reported, stream: from.includes('whatsapp'), pipe });
  return uri;
}
/** A plain file (from a file manager), which is read in place. */
const FILES = 'file:///storage/emulated/0/Download';
const keys = () => [...memfs.disk.keys()];
const booksOnShelf = () => new Set(keys().filter((k) => k.startsWith('mem://doc/books/')).map((k) => k.split('/')[4])).size;
const tempLeft = () => keys().filter((k) => k.startsWith('mem://cache/') && memfs.disk.get(k)?.kind === 'file');
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
/** Every copy made: [from, to]. */
const copies: [string, string][] = [];
const realCopy = memfs.File.prototype.copy;
memfs.File.prototype.copy = function (this: memfs.File, dest: memfs.File | memfs.Directory, opts?: { overwrite?: boolean }) {
  copies.push([this.uri, dest.uri]);
  return realCopy.call(this, dest, opts);
};

beforeAll(async () => {
  memfs.resetDisk();
  // The app is up: the root layout has mounted.
  await renderHook(() => useSharedFileNavigation());
});

beforeEach(async () => {
  mockPush.mockClear();
  mockReplace.mockClear();
  alert.mockClear();
  mockPath = '/';
});

const platform = Platform.OS;
afterEach(() => Object.defineProperty(Platform, 'OS', { value: platform, configurable: true }));

it('a cold start waits for the first screen, then opens the new book', async () => {
  // A fresh start of the app, whatever ran before.
  await jest.isolateModulesAsync(async () => {
    const rtl: typeof import('@testing-library/react-native/pure') = require('@testing-library/react-native/pure');
    const fresh: typeof import('@/lib/openWith') = require('@/lib/openWith');
    const { getBook: getFreshBook }: typeof import('@/lib/library') = require('@/lib/library');
    const freshAlert = jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(() => {});

    const done = fresh.openSharedFile(share(makeEpub('A cold start. '), 'document'));
    await rtl.act(() => new Promise((r) => setTimeout(r, 20)));
    expect(mockPush).not.toHaveBeenCalled(); // the navigator isn't mounted yet
    await rtl.renderHook(() => fresh.useSharedFileNavigation());
    await rtl.act(() => done);
    expect(mockPush).toHaveBeenCalledTimes(1);
    const id = mockPush.mock.calls[0][0].params.id;
    expect(mockPush.mock.calls[0][0].pathname).toBe('/reader/[id]');
    // Only an id from WhatsApp: recognised as an EPUB from its bytes; its own title is used once it's prepared.
    expect(getFreshBook(id)).toMatchObject({ fileName: 'Untitled.epub', sourceName: 'source.epub', status: 'processing' });
    expect(tempLeft()).toEqual([]);
    expect(freshAlert).not.toHaveBeenCalled();
    rtl.cleanup();
  });
});

it('the book’s own file is still there once it’s added: pictures, "Try again" and later conversions need it', async () => {
  const res = await importSharedFile(share(makeEpub('Pictures inside. '), 'pictures.epub'));
  const book = 'book' in res ? res.book : undefined;
  expect(book).toBeTruthy();
  expect(sourceFile(getBook(book!.id)!).exists).toBe(true);
  expect(memfs.disk.get(`mem://doc/books/${book!.id}/source.epub`)).toMatchObject({ kind: 'file' });
  expect(tempLeft()).toEqual([]);
});

it('a book shared while another is being prepared keeps its file until its turn comes', async () => {
  // The first one's conversion never finishes here: the second waits behind it.
  const first = await importSharedFile(share(makeEpub('First in line. '), 'first.epub'));
  const second = await importSharedFile(share(makeEpub('Second in line. '), 'second.epub'));
  for (const r of [first, second]) {
    const id = 'book' in r ? r.book.id : '';
    expect(memfs.disk.has(`mem://doc/books/${id}/source.epub`)).toBe(true);
  }
});

it('the same book shared again opens the one on the shelf instead of adding it', async () => {
  const res = await importSharedFile(share(epub, 'Moby Dick.epub'));
  const before = booksOnShelf();
  await openSharedFile(share(epub, 'other name'));
  expect(booksOnShelf()).toBe(before);
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/reader/[id]', params: { id: 'book' in res ? res.book.id : '' } });
  expect(tempLeft()).toEqual([]);
});

it('a book that failed to prepare, shared again, is not added again: its reader page offers to try again', async () => {
  const bytes = makeEpub('Locked. ');
  const first = await importSharedFile(share(bytes, 'locked.epub'));
  const id = 'book' in first ? first.book.id : '';
  updateBook(id, { status: 'error', error: 'This book is copy-protected (DRM)…' });
  const before = booksOnShelf();
  await openSharedFile(share(bytes, 'locked.epub'));
  expect(booksOnShelf()).toBe(before);
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/reader/[id]', params: { id } });
});

it('a book whose file an earlier version lost is repaired by sharing the same file again', async () => {
  const bytes = makeEpub('Lost and found. ');
  const first = await importSharedFile(share(bytes, 'lost.epub'));
  const id = 'book' in first ? first.book.id : '';
  // What the old "Open with" did: the book's file deleted right after adding it, so preparing it failed.
  memfs.disk.delete(`mem://doc/books/${id}/source.epub`);
  updateBook(id, { status: 'error', error: 'This book couldn’t be prepared. The file may be damaged or in a form this app can’t read.' });
  const before = booksOnShelf();
  await openSharedFile(share(bytes, 'lost again.epub'));
  expect(booksOnShelf()).toBe(before);
  expect(memfs.disk.has(`mem://doc/books/${id}/source.epub`)).toBe(true);
  expect(getBook(id)).toMatchObject({ status: 'processing', error: undefined });
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/reader/[id]', params: { id } });
});

it('a file shared under an id gets no made-up name; a real file name is kept', async () => {
  // The text's first line becomes its title when it's prepared (see txt.ts).
  const txt = await importSharedFile(share(strToU8('It was the best of times, it was the worst of times.\n'), '1712345678'));
  expect('book' in txt && txt.book.fileName).toBe('Untitled.txt');
  const download = await importSharedFile(share(strToU8('Text.\n'), 'msf:1000001234'));
  expect('book' in download && download.book.fileName).toBe('Untitled.txt');
  const named = await importSharedFile(share(zipSync({ 'War and Peace.fb2': strToU8('<FictionBook/>') }), 'War and Peace.zip'));
  expect('book' in named && named.book).toMatchObject({ fileName: 'War and Peace.fb2.zip', title: 'War and Peace', sourceName: 'source.fb2.zip' });
});

it('a hostile file name can neither write outside the app’s folder for shared files nor become a path', async () => {
  const hostile = '../../doc/library.json';
  const uri = share(makeEpub('Hostile. '), hostile, { reported: '../../../doc/library.json' });
  const res = await importSharedFile(uri);
  expect(copies.find(([from]) => from === uri)?.[1]).toMatch(/^mem:\/\/cache\/incoming\/[a-z0-9]+$/);
  // The library is still the library, not the shared file.
  expect(Array.isArray(JSON.parse(new memfs.File('mem://doc/library.json').textSync()))).toBe(true);
  expect('book' in res && res.book).toMatchObject({ fileName: 'Untitled.epub', sourceName: 'source.epub' });

  const odd = await importSharedFile(share(makeEpub('Odd. '), '..\\..\\Bad\u0007\nName' + 'x'.repeat(80) + '.epub'));
  const fileName = 'book' in odd ? odd.book.fileName : '';
  expect(fileName).toMatch(/^BadNamex+\.epub$/);
  expect(fileName.length).toBeLessThanOrEqual(125);
});

it('a file that is not a book is refused with a clear message, without copying it when it can be read in place', async () => {
  const before = booksOnShelf();
  const copied = copies.length;
  await openSharedFile(share(png, 'IMG-2024.png', { from: FILES }));
  expect(copies.length).toBe(copied); // a huge video would not be copied either
  expect(alert).toHaveBeenCalledWith('This file isn’t a book the app can open', expect.stringMatching(/EPUB, FB2, MOBI, AZW3 or TXT/));
  // A chat app's file can only be read by copying it; the copy is removed.
  await openSharedFile(share(png, 'IMG-2025.png'));
  expect(alert).toHaveBeenCalledTimes(2);
  expect(mockPush).not.toHaveBeenCalled();
  expect(booksOnShelf()).toBe(before);
  expect(tempLeft()).toEqual([]);
});

it('a book from a file manager is recognised in place and added', async () => {
  const res = await importSharedFile(share(makeEpub('In place. '), 'Emma.epub', { from: FILES }));
  expect('book' in res && res.book.fileName).toBe('Emma.epub');
  expect(tempLeft()).toEqual([]);
});

it('a book handed over as a pipe (its copy comes out empty) is read through instead', async () => {
  const res = await importSharedFile(share(makeEpub('Through a pipe. '), 'piped.epub', { from: 'com.example.files/stream', pipe: true }));
  expect('book' in res && res.book.fileName).toBe('piped.epub');
  const id = 'book' in res ? res.book.id : '';
  expect((memfs.disk.get(`mem://doc/books/${id}/source.epub`) as { data: Uint8Array }).data.length).toBeGreaterThan(100);
});

it('a file that can no longer be read says so, in words that fit', async () => {
  await openSharedFile('content://com.whatsapp.provider.media/item/expired');
  expect(alert).toHaveBeenCalledWith('Couldn’t open this file', expect.stringMatching(/didn’t let this app read it/));
  expect(mockPush).not.toHaveBeenCalled();
});

it('no room on the phone: says that, not that the file can’t be read', async () => {
  memfs.setFreeSpace(10);
  try {
    await openSharedFile(share(makeEpub('Too big for the phone. '), 'big.epub'));
  } finally {
    memfs.setFreeSpace(undefined);
  }
  expect(alert).toHaveBeenCalledWith('Not enough free space', expect.any(String));
  expect(tempLeft()).toEqual([]);
});

it('a book that can’t be put on the shelf for another reason says so, not that the phone is full', async () => {
  // Moving the app's own copy into the book's folder fails (not for space).
  const move = memfs.File.prototype.moveSync;
  const spy = jest.spyOn(memfs.File.prototype, 'moveSync').mockImplementation(function (this: memfs.File, ...args) {
    if (this.uri.startsWith('mem://cache/incoming/')) throw new Error('java.io.IOException: I/O error');
    return move.apply(this, args);
  });
  try {
    await openSharedFile(share(makeEpub('Stuck on the way in. '), 'stuck.epub'));
  } finally {
    spy.mockRestore();
  }
  expect(alert).toHaveBeenCalledWith('Couldn’t add this book', expect.stringMatching(/Crash log/));
  expect(alert).not.toHaveBeenCalledWith('Not enough free space', expect.anything());
  expect(mockPush).not.toHaveBeenCalled();
  expect(tempLeft()).toEqual([]);
});

it('the library knows while a shared file is being added', async () => {
  // Every value the library screen is drawn with (the whole add finishes within one act()).
  const seen: boolean[] = [];
  const { result } = await renderHook(() => {
    const adding = useAddingSharedFile();
    seen.push(adding);
    return adding;
  });
  expect(result.current).toBe(false);
  await act(() => openSharedFile(share(makeEpub('Busy. '), 'busy.epub')));
  expect(seen).toContain(true); // "Adding book…" was shown
  expect(result.current).toBe(false); // and is gone once it's added
});

it('a book shared while another is open replaces it in the reader instead of piling up on top', async () => {
  // Reading a book: the root layout follows the route.
  mockPath = '/reader/abc';
  await renderHook(() => useSharedFileNavigation());
  await openSharedFile(share(makeEpub('Next book. '), 'next book.epub'));
  expect(mockReplace).toHaveBeenCalledWith({ pathname: '/reader/[id]', params: { id: expect.any(String) } });
  expect(mockPush).not.toHaveBeenCalled();
  // Back in the library: opened on top of it again.
  mockPath = '/';
  await renderHook(() => useSharedFileNavigation());
});

it('the file that started the app, given again (back from recent apps, or opened again later), opens its book', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  const data = makeEpub('Launch. ');
  const uri = share(data, 'launch.epub');
  expect(redirectSystemPath({ path: uri, initial: true })).toBe('/');
  await settle();
  expect(mockPush).toHaveBeenCalledTimes(1);
  const id = mockPush.mock.calls[0][0].params.id;
  const before = booksOnShelf();

  // Killed in the background and brought back from recent apps: the same launch URL, which the
  // app it came from may no longer let us read. The book opens as it is on the shelf.
  memfs.putForeign(uri, data, { denied: true });
  expect(redirectSystemPath({ path: uri, initial: true })).toBe('/');
  await settle();
  expect(mockPush).toHaveBeenCalledTimes(2);
  expect(mockPush.mock.calls[1][0].params.id).toBe(id);
  expect(alert).not.toHaveBeenCalled();
  expect(booksOnShelf()).toBe(before);

  // Removed since, and that file opened again: added again.
  deleteBook(id);
  memfs.putForeign(uri, data, { stream: true });
  redirectSystemPath({ path: uri, initial: true });
  await settle();
  expect(mockPush).toHaveBeenCalledTimes(3);
  expect(mockPush.mock.calls[2][0].params.id).not.toBe(id);
});

it('a file shared while the app runs keeps the current screen until it is opened, or refused', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  expect(redirectSystemPath({ path: share(png, 'photo.png'), initial: false })).toBeNull();
  await settle();
  expect(alert).toHaveBeenCalledWith('This file isn’t a book the app can open', expect.any(String));
  expect(mockPush).not.toHaveBeenCalled();
  expect(redirectSystemPath({ path: share(makeEpub('While reading. '), 'next.epub'), initial: false })).toBeNull();
  await settle();
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/reader/[id]', params: { id: expect.any(String) } });
});

it('on iPhone, a book opened from another app arrives as a copy in Documents/Inbox: added, opened, and the copy removed', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  const uri = 'file:///private/var/mobile/Containers/Data/Application/0A1B/Documents/Inbox/The%20Sea.epub';
  memfs.putFile(uri, makeEpub('Opened in from Files. '));
  const before = booksOnShelf();
  expect(redirectSystemPath({ path: uri, initial: false })).toBeNull();
  await settle();
  expect(booksOnShelf()).toBe(before + 1);
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/reader/[id]', params: { id: expect.any(String) } });
  expect(memfs.disk.has(uri)).toBe(false);
  // A file elsewhere (an Android file manager's) is never deleted.
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  const kept = share(makeEpub('Kept where it is. '), 'kept.epub', { from: FILES });
  await openSharedFile(kept);
  expect(memfs.disk.has(kept)).toBe(true);
});

it('app links pass through on both phones', () => {
  for (const os of ['ios', 'android']) {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
    expect(redirectSystemPath({ path: 'necreader://notes', initial: false })).toBe('necreader://notes');
  }
});
