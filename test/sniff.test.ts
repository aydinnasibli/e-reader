// Recognising a book from its bytes (files opened from WhatsApp, Telegram...
// often have no extension), and the wording of conversion errors.

import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { describeError, friendlyStoredError, sniffFormat } from '../src/engine/ingest';
import { BookError } from '../src/engine/io';
import { MobiError } from '../src/engine/mobi';
import { MemorySource, enc } from './helpers';
import { buildMobi } from './mobiFixture';

const sniff = (bytes: Uint8Array) => sniffFormat(new MemorySource(bytes));

describe('sniffFormat', () => {
  it('EPUB: by its mimetype, or by its container when the mimetype is missing', () => {
    expect(sniff(zipSync({ mimetype: strToU8('application/epub+zip'), 'OEBPS/a.xhtml': strToU8('<p/>') }))).toBe('epub');
    expect(sniff(zipSync({ 'META-INF/container.xml': strToU8('<container/>') }))).toBe('epub');
  });

  it('a ZIP with an FB2 inside is fb2.zip; any other ZIP is not a book', () => {
    expect(sniff(zipSync({ 'Book.FB2': strToU8('<FictionBook/>') }))).toBe('fb2.zip');
    expect(sniff(zipSync({ 'word/document.xml': strToU8('<w/>'), '[Content_Types].xml': strToU8('<x/>') }))).toBeNull();
  });

  it('Kindle books: MOBI and KF8 (AZW3)', () => {
    expect(sniff(buildMobi({ html: '<p>x</p>', title: 'M' }))).toBe('mobi');
    expect(sniff(buildMobi({ html: '<html><body><p>x</p></body></html>', title: 'K', kf8: true }))).toBe('azw3');
  });

  it('FB2, also in UTF-16', () => {
    const xml = '<?xml version="1.0" encoding="utf-8"?>\n<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><body/></FictionBook>';
    expect(sniff(enc(xml))).toBe('fb2');
    const utf16 = new Uint8Array(2 + xml.length * 2);
    utf16.set([0xff, 0xfe]);
    for (let i = 0; i < xml.length; i++) utf16[2 + i * 2] = xml.charCodeAt(i);
    expect(sniff(utf16)).toBe('fb2');
  });

  it('plain text in common encodings is txt', () => {
    expect(sniff(enc('Chapter 1\n\nIt was a bright cold day in April, and the clocks were striking thirteen.\r\n'))).toBe('txt');
    expect(sniff(enc('Глава первая. Всё смешалось в доме Облонских.'))).toBe('txt');
    // Windows-1251 Russian: not valid UTF-8, still text.
    expect(sniff(Uint8Array.from([0xc3, 0xeb, 0xe0, 0xe2, 0xe0, 0x20, 0xef, 0xe5, 0xf0, 0xe2, 0xe0, 0xff, 0x0d, 0x0a]))).toBe('txt');
  });

  it('binary files are not books', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 1, 0, 8, 6, 0, 0, 0]);
    expect(sniff(png)).toBeNull();
    expect(sniff(enc('%PDF-1.7\n%âãÏÓ\n1 0 obj << /Type /Catalog >> endobj'))).toBeNull();
    const noise = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7919 + 13) & 255);
    expect(sniff(noise)).toBeNull();
    expect(sniff(new Uint8Array(0))).toBeNull();
    // A damaged ZIP (header only) isn't one either.
    expect(sniff(Uint8Array.from([0x50, 0x4b, 3, 4, 1, 2, 3]))).toBeNull();
  });
});

describe('error messages', () => {
  it('book problems are shown as written; internal errors become a plain sentence', () => {
    expect(describeError(new MobiError('This book is DRM-protected, so it can only be read in the store’s own app.'))).toMatch(/^This book is DRM-protected/);
    expect(describeError(new BookError('This archive has no EPUB or FB2 book inside.'))).toBe('This archive has no EPUB or FB2 book inside.');
    const internal = describeError(new TypeError("Cannot read property 'length' of undefined"));
    expect(internal).toMatch(/couldn’t be prepared/);
    expect(internal).not.toMatch(/TypeError|undefined/);
    expect(describeError('Bad local header for OEBPS/a.xhtml')).toMatch(/couldn’t be prepared/);
    expect(describeError(new Error('write failed: ENOSPC (No space left on device)'))).toMatch(/free space/);
  });

  it('internal messages saved by older versions are reworded, friendly ones kept', () => {
    expect(friendlyStoredError('TypeError: undefined is not an object')).toMatch(/couldn’t be prepared/);
    expect(friendlyStoredError('Not a ZIP file (no end of central directory)')).toMatch(/couldn’t be prepared/);
    const kept = 'Preparing this book stopped the app. The file may be damaged or unusual.';
    expect(friendlyStoredError(kept)).toBe(kept);
    expect(friendlyStoredError(undefined)).toBeUndefined();
  });
});
