/// <reference types="jest" />
// Adding books: the same file twice is noticed and not added again, and
// files without a book extension are recognised from their bytes.

const mockFiles = new Map<string, Uint8Array>();
const mockPicks: { name: string; uri: string; size?: number }[][] = [];

jest.mock('expo-file-system', () => {
  const path = (a: unknown, b?: string) => (b ? `${typeof a === 'string' ? a : (a as { uri: string }).uri}/${b}` : String(a));
  class File {
    uri: string;
    constructor(a: unknown, b?: string) {
      this.uri = path(a, b);
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
    constructor(a: unknown, b?: string) {
      this.uri = path(a, b);
    }
    exists = false;
    delete() {}
  }
  return { File, Directory, Paths: { document: 'doc' } };
});
jest.mock('@/lib/storage', () => {
  const { File } = require('expo-file-system');
  return {
    readJson: () => null,
    writeJson: () => {},
    saveJson: () => true,
    bookDir: (id: string) => `doc/books/${id}`,
    booksDir: () => 'doc/books',
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
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: () => Promise.resolve({ canceled: false, assets: mockPicks.shift() ?? [] }),
}));
// Conversion isn't what this tests: it never finishes.
jest.mock('@/engine/ingest', () => ({
  ...jest.requireActual('@/engine/ingest'),
  ingestBook: () => new Promise(() => {}),
}));

import { strToU8, zipSync } from 'fflate';
import { getBook, importBooks, updateBook } from '@/lib/library';

const bytes = (seed: number, n = 200_000) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);
/** The picker hands over a fresh private copy of the chosen file each time. */
let copies = 0;
function pick(...files: [string, Uint8Array][]) {
  mockPicks.push(
    files.map(([name, data]) => {
      const uri = `cache/${++copies}/${name}`;
      mockFiles.set(uri, data);
      return { name, uri, size: data.length };
    }),
  );
}

it('the same book added again is not added twice, and the picked copy is cleaned up', async () => {
  const moby = bytes(1);
  pick(['moby.epub', moby]);
  expect(await importBooks()).toMatchObject({ added: 1, duplicates: [] });

  // Same file, even under another name; and a different book of the same size.
  pick(['Moby Dick (1).epub', moby], ['other.epub', bytes(2)]);
  const res = await importBooks();
  expect(res.added).toBe(1);
  expect(res.duplicates).toEqual([['Moby Dick (1).epub', 'moby']]);
  expect([...mockFiles.keys()].filter((k) => k.startsWith('cache/'))).toEqual([]);
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
  // Pretend it was added by an older version: no fingerprint saved.
  const added = [...mockFiles.keys()].find((k) => k.startsWith('doc/books/') && mockFiles.get(k) === old)!;
  const id = added.split('/')[2];
  delete (getBook(id) as { fp?: string }).fp;

  pick(['old again.txt', old]);
  const res = await importBooks();
  expect(res.added).toBe(0);
  expect(res.duplicates).toHaveLength(1);
  expect(getBook(id)!.fp).toBeTruthy(); // filled in for next time
});

/** The id of the book on the shelf whose original file is `data`. */
const shelfId = (data: Uint8Array) => [...mockFiles.keys()].find((k) => k.startsWith('doc/books/') && mockFiles.get(k) === data)!.split('/')[2];

it('a file without a book extension is recognised from its bytes, like a shared one; other files are skipped', async () => {
  const epub = zipSync({ mimetype: strToU8('application/epub+zip'), 'META-INF/container.xml': strToU8('<container/>') });
  pick(['document', epub], ['page.html', strToU8('<!DOCTYPE html><html><body>Hi</body></html>')]);
  const res = await importBooks();
  expect(res).toMatchObject({ added: 1, skipped: ['page.html'] });
  expect(getBook(shelfId(epub))).toMatchObject({ fileName: 'document.epub', sourceName: 'source.epub', title: 'document' });
});

it('a book that failed to prepare is not added again: the one on the shelf offers to try again', async () => {
  const locked = bytes(11, 3000);
  pick(['locked.epub', locked]);
  await importBooks();
  updateBook(shelfId(locked), { status: 'error', error: 'This book is copy-protected (DRM)…' });

  pick(['locked.epub', locked]);
  expect(await importBooks()).toMatchObject({ added: 0, duplicates: [['locked.epub', 'locked']] });
});
