/// <reference types="jest" />
// A book's pictures taken out of its EPUB (a ZIP) the first time a chunk with
// them is shown: a slice at a time, with pauses for the app between them, so
// a big picture doesn't hold up the reader while the next chunk is prepared.

import { zipSync } from 'fflate';
import { Image } from 'react-native';
import type { Manifest } from '@/engine/types';
import { ZipArchive } from '@/engine/zip';
import { BookData } from '@/reader/book';
import * as breathing from '@/reader/breather';

/** The book's file, in memory, and what was written beside it. */
const mockDisk = { book: new Uint8Array(0), written: new Map<string, Uint8Array>() };
jest.mock('@/lib/storage', () => ({
  FileSource: class {
    size = mockDisk.book.length;
    read(offset: number, length: number) {
      return mockDisk.book.slice(offset, offset + length);
    }
    close() {}
  },
  chunkFile: () => ({ text: () => Promise.reject(new Error('no chunks')) }),
  imageFile: (id: string, name: string) => ({
    get exists() {
      return mockDisk.written.has(name);
    },
    uri: `file:///doc/books/${id}/img/${name}`,
    writeSync: (bytes: Uint8Array) => mockDisk.written.set(name, bytes),
  }),
  safeImageName: (key: string) => key.replace(/[^A-Za-z0-9._-]/g, '_'),
}));
jest.mock('@/lib/library', () => ({ sourceFile: () => ({}) }));

// A photo-sized picture that hardly compresses (as JPEG and PNG data don't).
const picture = new Uint8Array(300_000);
let seed = 7;
for (let i = 0; i < picture.length; i++) {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  picture[i] = seed & 255;
}

beforeAll(() => {
  mockDisk.book = zipSync({ 'mimetype': new TextEncoder().encode('application/epub+zip'), 'OEBPS/big.png': [picture, { level: 6 }] });
  jest.spyOn(Image, 'getSize').mockImplementation((_uri, ok) => ok(800, 600));
});

function bookWith(images: Manifest['images']) {
  const book = new BookData({ id: 'pics', title: 'Pictures', author: '', status: 'ready', format: 'epub', fileName: 'pics.epub' } as never);
  book.setManifest({ v: 3, format: 'epub', title: 'Pictures', author: '', totalBlocks: 1, totalChars: 1, chunks: [[0, 0]], toc: [], images } as Manifest);
  return book;
}

it('a picture for a chunk made in the background is taken out in slices with pauses between them, written whole, and sized', async () => {
  const entry = ZipArchive.open({ size: mockDisk.book.length, read: (o: number, n: number) => mockDisk.book.slice(o, o + n) }).find('OEBPS/big.png')!;
  expect(entry.method).toBe(8);
  const book = bookWith({ 'OEBPS/big.png': { zip: [entry.offset, entry.compressedSize, entry.size, entry.method], ext: 'png' } });
  let pauses = 0;
  const info = await book.imageInfo('OEBPS/big.png', async () => void pauses++);
  expect(info).toEqual({ uri: 'file:///doc/books/pics/img/z_OEBPS_big.png.png', width: 800, height: 600 });
  expect(mockDisk.written.get('z_OEBPS_big.png.png')).toEqual(picture);
  // About 300 KB read 16 KB at a time: a pause after each slice.
  expect(pauses).toBeGreaterThan(10);
});

it('one wanted on screen is taken out at once, without pauses (a pause waits for the next frame)', async () => {
  mockDisk.written.clear();
  const entry = ZipArchive.open({ size: mockDisk.book.length, read: (o: number, n: number) => mockDisk.book.slice(o, o + n) }).find('OEBPS/big.png')!;
  const book = bookWith({ 'OEBPS/big.png': { zip: [entry.offset, entry.compressedSize, entry.size, entry.method], ext: 'png' } });
  const made = jest.spyOn(breathing, 'breather');
  try {
    expect(await book.imageInfo('OEBPS/big.png')).toMatchObject({ width: 800, height: 600 });
    expect(mockDisk.written.get('z_OEBPS_big.png.png')).toEqual(picture);
    expect(made).not.toHaveBeenCalled();
  } finally {
    made.mockRestore();
  }
});
