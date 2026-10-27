// Entry point: figure out what kind of file this is and convert it.

import { be32 } from './bytes';
import { createDecoder, detectBom, sniffEncoding } from './decode';
import { ingestEpub } from './epub';
import { ingestFb2 } from './fb2';
import { ingestMobi, isMobi } from './mobi';
import { BookError, type ByteSource, type IngestContext, UNTITLED } from './io';
import { ingestTxt } from './txt';
import type { Manifest } from './types';
import { ZipArchive, type ZipEntry, leadingEntries } from './zip';

/** File name endings of the books this app reads (".fb2.zip" before ".zip"). */
const BOOK_EXTENSION = /\.(fb2\.zip|epub|fb2|txt|mobi|azw3|azw|prc|zip)$/i;
const KINDLE_EXTENSIONS = ['mobi', 'azw3', 'azw', 'prc'];

/** The book extension a file name ends with ("epub", "fb2.zip"...), in lower case; null if none. */
export function bookExtension(name: string): string | null {
  return BOOK_EXTENSION.exec(name)?.[1].toLowerCase() ?? null;
}

export function isSupportedName(name: string): boolean {
  return bookExtension(name) !== null;
}

export type SniffedFormat = 'epub' | 'fb2' | 'fb2.zip' | 'mobi' | 'azw3' | 'txt';

/**
 * What kind of book the bytes are, for files that arrive without a usable
 * name (WhatsApp and Telegram often hand over "document" or a number).
 * Null when it isn't a book this app reads. Only the start of the file and,
 * for ZIPs, the central directory are read.
 */
export function sniffFormat(src: ByteSource): SniffedFormat | null {
  if (src.size === 0) return null;
  if (isMobi(src)) return mobiVersion(src) >= 8 ? 'azw3' : 'mobi';
  const head = src.read(0, Math.min(src.size, 4096));
  if (isZip(head)) {
    try {
      return zipBook(ZipArchive.open(src))?.format ?? null;
    } catch {
      // Cut short, its directory gone: the book its first entries say it is
      // (so it's told it's damaged, not that it isn't a book).
      return cutZipBook(src);
    }
  }
  if (looksLikeFb2(head)) return 'fb2';
  return looksLikePlainText(head) ? 'txt' : null;
}

/**
 * The name to keep a shared file under: its own when it already says what
 * the file is, otherwise with the recognised format's extension
 * ("document" -> "document.epub", "book.zip" -> "book.fb2.zip").
 */
export function bookFileName(name: string, format: SniffedFormat): string {
  const n = name.trim() || UNTITLED;
  const ext = bookExtension(n);
  const kindle = format === 'mobi' || format === 'azw3';
  if (ext === format || (kindle && ext && KINDLE_EXTENSIONS.includes(ext))) return n;
  return n.replace(BOOK_EXTENSION, '') + '.' + format;
}

const isZip = (head: Uint8Array) => head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4;

type ZipBook = { format: 'epub' } | { format: 'fb2.zip'; entry: ZipEntry };

/** The book inside a ZIP: what ingestBook reads it as, and so what sniffFormat calls it. */
function zipBook(zip: ZipArchive): ZipBook | null {
  const mime = zip.find('mimetype');
  let epubMime = false;
  if (mime && mime.size < 100) {
    try {
      epubMime = String.fromCharCode(...zip.read(mime)).trim() === 'application/epub+zip';
    } catch {
      // a damaged mimetype entry: the other checks decide
    }
  }
  if (epubMime || zip.find('META-INF/container.xml') || [...zip.entries.keys()].some((n) => n.toLowerCase().endsWith('.opf'))) {
    return { format: 'epub' };
  }
  const entry = [...zip.entries.values()].find((e) => e.name.toLowerCase().endsWith('.fb2'));
  return entry ? { format: 'fb2.zip', entry } : null;
}

/** What a ZIP cut short holds, from the entries it starts with (an EPUB starts with its mimetype). */
function cutZipBook(src: ByteSource): 'epub' | 'fb2.zip' | null {
  for (const e of leadingEntries(src)) {
    const name = e.name.toLowerCase();
    if (name === 'mimetype') {
      if (e.method !== 0 || e.compressedSize > 100) continue;
      if (String.fromCharCode(...src.read(e.dataOffset, e.compressedSize)).trim() === 'application/epub+zip') return 'epub';
    } else if (name === 'meta-inf/container.xml' || name.endsWith('.opf')) return 'epub';
    else if (name.endsWith('.fb2')) return 'fb2.zip';
  }
  return null;
}

/** Mobipocket header version of the first record; 8 and up is KF8 (AZW3). */
function mobiVersion(src: ByteSource): number {
  const first = src.read(78, 4);
  if (first.length < 4) return 0;
  const h = src.read(be32(first, 0) + 16, 24);
  if (h.length < 24 || String.fromCharCode(h[0], h[1], h[2], h[3]) !== 'MOBI') return 0;
  return be32(h, 20);
}

// Text that would show as raw code: a tag, declaration or comment ("<html",
// "<svg", "<?xml", "<!DOCTYPE"), a JSON object or array, an RTF document.
const MARKUP = /^(<[a-z!?]|\{\s*["}]|\[\s*[[{"\]]|\{\\rtf)/i;

/**
 * True if the sample reads as plain text in some encoding: hardly any
 * control characters or undecodable bytes (binary files such as images,
 * PDFs and archives are full of both whatever encoding they're decoded
 * with), and not markup or data: HTML, SVG and other XML, JSON, RTF.
 */
function looksLikePlainText(sample: Uint8Array): boolean {
  if (!sample.length) return false;
  if (sample[0] === 0x25 && sample[1] === 0x50 && sample[2] === 0x44 && sample[3] === 0x46) return false; // %PDF
  const enc = sniffEncoding(sample);
  const bom = detectBom(sample);
  // A character cut off at the end of the sample is not a sign of binary.
  const text = createDecoder(enc, false).decode(sample.subarray(bom?.skip ?? 0));
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // Tab, line feed, vertical tab, form feed, carriage return and the DOS end-of-file mark are fine.
    if ((c < 32 && !(c >= 9 && c <= 13) && c !== 26) || c === 0xfffd) bad++;
  }
  return bad <= text.length * 0.01 && !MARKUP.test(text.trimStart());
}

/** What a file that isn't any book this app reads is told. */
export const NOT_A_BOOK = 'This file isn’t a book the app can open (EPUB, FB2, MOBI, AZW3 or TXT).';
const EMPTY_BOOK = 'This book is empty: there’s no text or picture in it the app can show.';

export async function ingestBook(ctx: IngestContext, fileName: string): Promise<Manifest> {
  const manifest = await convert(ctx, fileName);
  // A book of nothing (an empty spine, chapters that can't be found) is an error, not a blank book.
  if (!manifest.totalBlocks) throw new BookError(EMPTY_BOOK);
  return manifest;
}

async function convert(ctx: IngestContext, fileName: string): Promise<Manifest> {
  if (isMobi(ctx.src)) return ingestMobi(ctx);
  const head = ctx.src.read(0, Math.min(ctx.src.size, 4096));
  if (isZip(head)) {
    const zip = ZipArchive.open(ctx.src);
    const book = zipBook(zip);
    if (book?.format === 'epub') return ingestEpub(ctx, zip);
    if (book) return ingestFb2(ctx, zip, book.entry);
    throw new BookError('This archive has no EPUB or FB2 book inside.');
  }
  if (bookExtension(fileName) === 'fb2' || looksLikeFb2(head.subarray(0, 1024))) return ingestFb2(ctx);
  // Plain text only when it says it is, or reads as text: other files would become pages of garbage.
  if (bookExtension(fileName) === 'txt' || looksLikePlainText(head)) return ingestTxt(ctx);
  throw new BookError(otherFile(head) ?? NOT_A_BOOK);
}

/** A clearer word for files people often mistake for books the app reads. */
function otherFile(head: Uint8Array): string | null {
  const tag = String.fromCharCode(...head.subarray(0, 8));
  if (tag.startsWith('%PDF')) return 'This is a PDF, which the app can’t open. It reads EPUB, FB2, MOBI, AZW3 and TXT books.';
  if (tag.startsWith('CONT') || tag.slice(1, 7) === 'DRMION') return 'This is a Kindle KFX book, which only Amazon’s apps can open.';
  return null;
}

function looksLikeFb2(head: Uint8Array): boolean {
  let s = '';
  for (let i = 0; i < head.length; i++) if (head[i]) s += String.fromCharCode(head[i]);
  return /<FictionBook/i.test(s);
}

export function titleFromFileName(name: string): string {
  return name.replace(BOOK_EXTENSION, '').replace(/[_]+/g, ' ').trim() || UNTITLED;
}

const GENERIC_FAILURE = 'This book couldn’t be prepared. The file may be damaged or in a form this app can’t read.';
const NO_SPACE = 'There isn’t enough free space on this phone to prepare this book.';

/**
 * The sentence to show when preparing a book failed. Problems with the book
 * itself (BookError) are already worded for people; anything else is an
 * internal message ("TypeError: …", "Bad local header…") that would only
 * confuse, so it becomes a plain explanation.
 */
export function describeError(e: unknown): string {
  if (e instanceof BookError) return e.message;
  const m = e instanceof Error ? e.message : String(e);
  return /ENOSPC|no space left|not enough (free )?space|disk full|storage full/i.test(m) ? NO_SPACE : GENERIC_FAILURE;
}

// Internal messages saved as the book's error by versions before describeError.
const INTERNAL = /\b[A-Z]\w*Error\b|\bundefined\b|\bnull\b|\bNaN\b|is not a function|is not an object|Cannot read|Cannot convert|Maximum call stack|out of memory|Not a ZIP file|Bad local header|Unsupported compression method/;

/** A saved error message, made readable if it's an internal one. */
export function friendlyStoredError(message: string | undefined): string | undefined {
  if (!message || !INTERNAL.test(message)) return message;
  return describeError(new Error(message));
}
