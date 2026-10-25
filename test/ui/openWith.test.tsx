/// <reference types="jest" />
// "Open with" on Android and "Open in" on iPhone: a book file shared from another app is recognised
// from its bytes, copied, added (or found on the shelf) and opened.

import { strToU8, zipSync } from 'fflate';

const mockFiles = new Map<string, Uint8Array>();
/** The names content providers report for their files: chosen by the sending app, so anything at all. */
const mockNames = new Map<string, string>();
/** Saved JSON (the library, the last launch URL), by file uri. */
const mockDisk = new Map<string, unknown>();
/** Every copy made of a shared file: [from, to]. */
const mockCopies: [string, string][] = [];
const mockPush = jest.fn();

jest.mock('expo-file-system', () => {
  const join = (...parts: unknown[]) => parts.map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/');
  const under = (dir: string) => [...mockFiles.keys()].filter((k) => k.startsWith(dir + '/'));
  /** "a/b/../c" -> "a/c", as the file system resolves it. */
  const resolve = (path: string) =>
    path.split('/').reduce<string[]>((out, part) => (part === '..' ? out.slice(0, -1) : [...out, part]), []).join('/');
  class File {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(...parts);
    }
    get exists() {
      return mockFiles.has(this.uri);
    }
    get size() {
      return mockFiles.get(this.uri)?.length ?? 0;
    }
    get name() {
      return this.uri.split('/').pop()!;
    }
    /** Like the native module: copied into a folder, the file is named by the provider, unchecked. */
    async copy(to: { uri: string }) {
      const data = mockFiles.get(this.uri);
      if (!data) throw new Error('Permission denied');
      const dest = to instanceof Directory ? resolve(`${to.uri}/${mockNames.get(this.uri) ?? this.name}`) : to.uri;
      mockCopies.push([this.uri, dest]);
      mockFiles.set(dest, data);
    }
    moveSync(to: { uri: string }) {
      mockFiles.set(to.uri, mockFiles.get(this.uri)!);
      mockFiles.delete(this.uri);
    }
    copySync(to: { uri: string }) {
      mockFiles.set(to.uri, mockFiles.get(this.uri)!);
    }
    delete() {
      mockFiles.delete(this.uri);
    }
  }
  class Directory {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(...parts);
    }
    get exists() {
      return under(this.uri).length > 0;
    }
    list() {
      return under(this.uri)
        .filter((k) => !k.slice(this.uri.length + 1).includes('/'))
        .map((k) => new File(k));
    }
    delete() {
      for (const k of under(this.uri)) mockFiles.delete(k);
    }
  }
  return { File, Directory, Paths: { document: 'doc', cache: 'cache' } };
});
jest.mock('@/lib/storage', () => {
  const { Directory, File } = require('expo-file-system');
  return {
    readJson: (f: { uri: string }) => mockDisk.get(f.uri) ?? null,
    writeJson: () => {},
    saveJson: (f: { uri: string }, v: unknown) => mockDisk.set(f.uri, JSON.parse(JSON.stringify(v))),
    bookDir: (id: string) => new Directory(`doc/books/${id}`),
    booksDir: () => new Directory('doc/books'),
    ensureDir: () => {},
    imageFile: () => ({ exists: false, uri: '' }),
    manifestFile: (id: string) => new File(`doc/books/${id}/manifest.json`),
    FileSink: class {},
    FileSource: class {
      bytes: Uint8Array;
      size: number;
      constructor(f: { uri: string }) {
        const b = mockFiles.get(f.uri);
        // Chat apps' providers can only be read from start to end: no file handle.
        if (!b || f.uri.startsWith('content://com.whatsapp')) throw new Error('File handle is not supported');
        this.bytes = b;
        this.size = b.length;
      }
      read(o: number, n: number) {
        return this.bytes.slice(o, o + n);
      }
      close() {}
    },
  };
});
jest.mock('expo-document-picker', () => ({ getDocumentAsync: () => Promise.resolve({ canceled: true, assets: [] }) }));
jest.mock('expo-router', () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
// Conversion isn't what this tests: it never finishes.
jest.mock('@/engine/ingest', () => ({
  ...jest.requireActual('@/engine/ingest'),
  ingestBook: () => new Promise(() => {}),
}));

import { act, renderHook } from '@testing-library/react-native';
import { Alert, Platform } from 'react-native';
import { redirectSystemPath } from '@/app/+native-intent';
import { deleteBook, getBook, importSharedFile, updateBook } from '@/lib/library';
import { openSharedFile, useAddingSharedFile, useSharedFileNavigation } from '@/lib/openWith';

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
 * Another app shares a file: a content:// URI (or a file:// one, when `from`
 * says so), ending in `name` (WhatsApp: often just an id), and the name its
 * provider reports (by default the same).
 */
function share(data: Uint8Array, name: string, { from = 'com.whatsapp.provider.media/item', reported = name } = {}) {
  const base = from.includes('://') ? from : `content://${from}`;
  const uri = `${base}/${++shares}/${encodeURIComponent(name)}`;
  mockFiles.set(uri, data);
  mockNames.set(uri, reported);
  return uri;
}
/** A plain file (from a file manager), which is read in place. */
const FILES = 'file:///storage/emulated/0/Download';
const booksOnShelf = () => new Set([...mockFiles.keys()].filter((k) => k.startsWith('doc/books/')).map((k) => k.split('/')[2])).size;
const tempLeft = () => [...mockFiles.keys()].filter((k) => k.startsWith('cache/'));
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

beforeAll(async () => {
  // The app is up: the root layout has mounted.
  await renderHook(() => useSharedFileNavigation());
});

beforeEach(async () => {
  mockPush.mockClear();
  alert.mockClear();
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
    expect(mockFiles.has(`doc/books/${id}/source.epub`)).toBe(true);
    expect(tempLeft()).toEqual([]);
    expect(freshAlert).not.toHaveBeenCalled();
    rtl.cleanup();
  });
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
  expect(mockCopies.find(([from]) => from === uri)?.[1]).toMatch(/^cache\/incoming\/[a-z0-9]+$/);
  expect([...mockFiles.keys()].filter((k) => !k.startsWith('content://') && !k.startsWith('doc/books/'))).toEqual([]);
  expect('book' in res && res.book).toMatchObject({ fileName: 'Untitled.epub', sourceName: 'source.epub' });

  const odd = await importSharedFile(share(makeEpub('Odd. '), '..\\..\\Bad\u0007\nName' + 'x'.repeat(80) + '.epub'));
  const fileName = 'book' in odd ? odd.book.fileName : '';
  expect(fileName).toMatch(/^BadNamex+\.epub$/);
  expect(fileName.length).toBeLessThanOrEqual(125);
});

it('a file that is not a book is refused with a clear message, without copying it when it can be read in place', async () => {
  const before = booksOnShelf();
  const copies = mockCopies.length;
  await openSharedFile(share(png, 'IMG-2024.png', { from: FILES }));
  expect(mockCopies.length).toBe(copies); // a huge video would not be copied either
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

it('a file that can no longer be read says so', async () => {
  await openSharedFile('content://com.whatsapp.provider.media/item/expired');
  expect(alert).toHaveBeenCalledWith('Couldn’t open this file', expect.any(String));
  expect(mockPush).not.toHaveBeenCalled();
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
  mockFiles.delete(uri);
  expect(redirectSystemPath({ path: uri, initial: true })).toBe('/');
  await settle();
  expect(mockPush).toHaveBeenCalledTimes(2);
  expect(mockPush.mock.calls[1][0].params.id).toBe(id);
  expect(alert).not.toHaveBeenCalled();
  expect(booksOnShelf()).toBe(before);

  // Removed since, and that file opened again: added again.
  deleteBook(id);
  mockFiles.set(uri, data);
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
  mockFiles.set(uri, makeEpub('Opened in from Files. '));
  const before = booksOnShelf();
  expect(redirectSystemPath({ path: uri, initial: false })).toBeNull();
  await settle();
  expect(booksOnShelf()).toBe(before + 1);
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/reader/[id]', params: { id: expect.any(String) } });
  expect(mockFiles.has(uri)).toBe(false);
  // A file elsewhere (an Android file manager's) is never deleted.
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  const kept = share(makeEpub('Kept where it is. '), 'kept.epub', { from: FILES });
  await openSharedFile(kept);
  expect(mockFiles.has(kept)).toBe(true);
});

it('app links pass through on both phones', () => {
  for (const os of ['ios', 'android']) {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
    expect(redirectSystemPath({ path: 'necreader://notes', initial: false })).toBe('necreader://notes');
  }
});
