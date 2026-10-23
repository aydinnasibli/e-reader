// Recognising a book from its bytes (files opened from WhatsApp, Telegram...
// often have no extension), and the wording of conversion errors.

import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { bookFileName, describeError, friendlyStoredError, isSupportedName, sniffFormat, titleFromFileName } from '../src/engine/ingest';
import { BookError, DRM_MESSAGE } from '../src/engine/io';
import { MobiError } from '../src/engine/mobi';
import { MemorySource, enc, ingestBytes } from './helpers';
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

  it('markup and data files are not books; CSV and other plain text is', () => {
    for (const s of [
      '<!DOCTYPE html>\n<html><body><p>Hi</p></body></html>',
      '\n  <html lang="en"><head><title>x</title>',
      '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>',
      '<svg width="10" height="10"></svg>',
      '<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel/></rss>',
      '<!-- saved page -->',
      '{"title": "Dune", "year": 1965}',
      '[\n  {"a": 1}\n]',
      '{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times;}} Hello}',
    ]) {
      expect(sniff(enc(s))).toBeNull();
    }
    expect(sniff(enc('title,author,year\nDune,Frank Herbert,1965\nEmma,Jane Austen,1815\n'))).toBe('txt');
    expect(sniff(enc('[Chapter One]\n\n<<Prologue>> It began with a letter.'))).toBe('txt');
  });

  it('a ZIP is called a book exactly when ingestBook reads it as one', async () => {
    const mimeOnly = zipSync({ mimetype: strToU8('application/epub+zip'), 'OEBPS/a.xhtml': strToU8('<p/>') });
    expect(sniff(mimeOnly)).toBe('epub');
    // Read as an EPUB, which says what is wrong with it.
    await expect(ingestBytes(mimeOnly, 'x')).rejects.toThrow(/This EPUB is damaged/);
    const docx = zipSync({ 'word/document.xml': strToU8('<w/>') });
    expect(sniff(docx)).toBeNull();
    await expect(ingestBytes(docx, 'x')).rejects.toThrow('This archive has no EPUB or FB2 book inside.');
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

describe('bookFileName', () => {
  it('keeps a name that already says what the file is, otherwise adds the format', () => {
    expect(bookFileName('Moby Dick.epub', 'epub')).toBe('Moby Dick.epub');
    expect(bookFileName('document', 'epub')).toBe('document.epub');
    expect(bookFileName('1712345678', 'txt')).toBe('1712345678.txt');
    expect(bookFileName('War and Peace.zip', 'fb2.zip')).toBe('War and Peace.fb2.zip');
    expect(bookFileName('Dune.azw', 'mobi')).toBe('Dune.azw');
    expect(bookFileName('Dune.mobi', 'azw3')).toBe('Dune.mobi');
    expect(bookFileName('notes.txt', 'epub')).toBe('notes.epub');
    expect(bookFileName('  ', 'txt')).toBe('Untitled.txt');
  });

  it('book names are recognised the same way everywhere', () => {
    expect(['a.epub', 'B.FB2.ZIP', 'c.fb2', 'd.txt', 'e.mobi', 'f.azw3', 'g.azw', 'h.prc', 'i.zip'].every(isSupportedName)).toBe(true);
    expect(['a.pdf', 'b.html', 'document', 'c.epub.part'].some(isSupportedName)).toBe(false);
    expect(titleFromFileName('War_and_Peace.FB2.zip')).toBe('War and Peace');
    expect(titleFromFileName('Dune.azw3')).toBe('Dune');
  });
});

describe('error messages', () => {
  it('book problems are shown as written; internal errors become a plain sentence', () => {
    expect(describeError(new MobiError(DRM_MESSAGE))).toBe(DRM_MESSAGE);
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
