/// <reference types="jest" />
// "Open with" on Android: a book file shared from another app is copied,
// recognised from its bytes, added (or found on the shelf) and opened.

import { strToU8, zipSync } from 'fflate';

const mockFiles = new Map<string, Uint8Array>();
/** The names content providers give their files (WhatsApp: often no extension). */
const mockNames = new Map<string, string>();
const mockPush = jest.fn();

jest.mock('expo-file-system', () => {
  const join = (...parts: unknown[]) => parts.map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/');
  const under = (dir: string) => [...mockFiles.keys()].filter((k) => k.startsWith(dir + '/'));
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
      return this.uri.split('/').pop();
    }
    /** Copying into a folder keeps the provider's display name, like the native module. */
    async copy(to: { uri: string }) {
      const data = mockFiles.get(this.uri);
      if (!data) throw new Error('Permission denied');
      mockFiles.set(`${to.uri}/${encodeURIComponent(mockNames.get(this.uri) ?? this.name!)}`, data);
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
    readJson: () => null,
    writeJson: () => {},
    saveJson: () => true,
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
        if (!b) throw new Error('no file');
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
import { getBook, importSharedFile } from '@/lib/library';
import { openSharedFile, useSharedFileNavigation } from '@/lib/openWith';

const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
const epub = zipSync({
  mimetype: strToU8('application/epub+zip'),
  'META-INF/container.xml': strToU8('<container/>'),
  'OEBPS/a.xhtml': strToU8('<p>' + 'Call me Ishmael. '.repeat(50) + '</p>'),
});
let shares = 0;
/** Another app shares a file: a content:// URI and the name its provider reports. */
function share(data: Uint8Array, name: string) {
  const uri = `content://com.whatsapp.provider.media/item/${++shares}`;
  mockFiles.set(uri, data);
  mockNames.set(uri, name);
  return uri;
}
const booksOnShelf = () => new Set([...mockFiles.keys()].filter((k) => k.startsWith('doc/books/')).map((k) => k.split('/')[2])).size;
const tempLeft = () => [...mockFiles.keys()].filter((k) => k.startsWith('cache/'));

beforeEach(() => {
  mockPush.mockClear();
  alert.mockClear();
});

it('a cold start waits for the first screen, then opens the new book', async () => {
  const done = openSharedFile(share(epub, 'document'));
  await act(() => new Promise((r) => setTimeout(r, 20)));
  expect(mockPush).not.toHaveBeenCalled(); // the navigator isn't mounted yet
  renderHook(() => useSharedFileNavigation());
  await act(() => done);
  expect(mockPush).toHaveBeenCalledTimes(1);
  const id = mockPush.mock.calls[0][0].params.id;
  expect(mockPush.mock.calls[0][0].pathname).toBe('/reader/[id]');
  // No extension from WhatsApp: recognised as an EPUB from its bytes.
  expect(getBook(id)).toMatchObject({ fileName: 'document.epub', sourceName: 'source.epub', status: 'processing' });
  expect(mockFiles.has(`doc/books/${id}/source.epub`)).toBe(true);
  expect(tempLeft()).toEqual([]);
  expect(alert).not.toHaveBeenCalled();
});

it('the same book shared again opens the one on the shelf instead of adding it', async () => {
  const before = booksOnShelf();
  const res = await importSharedFile(share(epub, 'Moby Dick.epub'));
  expect(res).toMatchObject({ duplicate: true });
  await openSharedFile(share(epub, 'other name'));
  expect(booksOnShelf()).toBe(before);
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/reader/[id]', params: { id: 'book' in res ? res.book.id : '' } });
  expect(tempLeft()).toEqual([]);
});

it('a text file with a number for a name, and a name with spaces', async () => {
  const txt = await importSharedFile(share(strToU8('It was the best of times, it was the worst of times.\n'), '1712345678'));
  expect('book' in txt && txt.book.fileName).toBe('1712345678.txt');
  const named = await importSharedFile(share(zipSync({ 'War and Peace.fb2': strToU8('<FictionBook/>') }), 'War and Peace.zip'));
  expect('book' in named && named.book).toMatchObject({ fileName: 'War and Peace.fb2.zip', title: 'War and Peace', sourceName: 'source.fb2.zip' });
});

it('a file that is not a book is refused with a clear message', async () => {
  const before = booksOnShelf();
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0]);
  await openSharedFile(share(png, 'IMG-2024.png'));
  expect(alert).toHaveBeenCalledWith('This file isn’t a book the app can open', expect.stringMatching(/EPUB, FB2, MOBI, AZW3 or TXT/));
  expect(mockPush).not.toHaveBeenCalled();
  expect(booksOnShelf()).toBe(before);
  expect(tempLeft()).toEqual([]);
});

it('a file that can no longer be read says so', async () => {
  await openSharedFile('content://com.whatsapp.provider.media/item/expired');
  expect(alert).toHaveBeenCalledWith('Couldn’t open this file', expect.any(String));
  expect(mockPush).not.toHaveBeenCalled();
});

it('only shared files on Android are taken over; app links pass through', () => {
  const restore = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  expect(redirectSystemPath({ path: 'content://x/1', initial: true })).toBe('content://x/1');
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  expect(redirectSystemPath({ path: 'necreader://notes', initial: false })).toBe('necreader://notes');
  expect(redirectSystemPath({ path: 'content://x/2', initial: false })).toBe('/'); // unreadable: an alert follows
  Object.defineProperty(Platform, 'OS', { value: restore, configurable: true });
});
