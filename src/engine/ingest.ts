// Entry point: figure out what kind of file this is and convert it.

import { createDecoder, detectBom, sniffEncoding } from './decode';
import { ingestEpub } from './epub';
import { ingestFb2 } from './fb2';
import { ingestMobi, isMobi } from './mobi';
import { BookError, type ByteSource, type IngestContext } from './io';
import { ingestTxt } from './txt';
import type { Manifest } from './types';
import { ZipArchive } from './zip';

export const SUPPORTED_EXTENSIONS = ['epub', 'fb2', 'fb2.zip', 'txt', 'mobi', 'azw3', 'azw', 'prc'];

export function isSupportedName(name: string): boolean {
  const n = name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((e) => n.endsWith('.' + e)) || n.endsWith('.zip');
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
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4) return sniffZip(src);
  if (looksLikeFb2(head)) return 'fb2';
  return looksLikeText(head) ? 'txt' : null;
}

function sniffZip(src: ByteSource): SniffedFormat | null {
  let zip: ZipArchive;
  try {
    zip = ZipArchive.open(src);
  } catch {
    return null;
  }
  const names = [...zip.entries.keys()].map((n) => n.toLowerCase());
  const mime = zip.find('mimetype');
  let epubMime = false;
  if (mime && mime.size < 100) {
    try {
      epubMime = String.fromCharCode(...zip.read(mime)).trim() === 'application/epub+zip';
    } catch {
      // a damaged mimetype entry: the other checks decide
    }
  }
  // Same tests ingestBook uses, so a sniffed book is read the same way.
  if (epubMime || zip.find('META-INF/container.xml') || names.some((n) => n.endsWith('.opf'))) return 'epub';
  if (names.some((n) => n.endsWith('.fb2'))) return 'fb2.zip';
  return null;
}

/** Mobipocket header version of the first record; 8 and up is KF8 (AZW3). */
function mobiVersion(src: ByteSource): number {
  const first = src.read(78, 4);
  if (first.length < 4) return 0;
  const rec0 = ((first[0] << 24) >>> 0) + ((first[1] << 16) | (first[2] << 8) | first[3]);
  const h = src.read(rec0 + 16, 24);
  if (h.length < 24 || String.fromCharCode(h[0], h[1], h[2], h[3]) !== 'MOBI') return 0;
  return ((h[20] << 24) >>> 0) + ((h[21] << 16) | (h[22] << 8) | h[23]);
}

/**
 * True if the sample reads as text in some encoding: hardly any control
 * characters or undecodable bytes. Binary files (images, PDFs, archives)
 * are full of both whatever encoding they're decoded with.
 */
function looksLikeText(sample: Uint8Array): boolean {
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
  return bad <= text.length * 0.01;
}

export async function ingestBook(ctx: IngestContext, fileName: string): Promise<Manifest> {
  const head = ctx.src.read(0, Math.min(ctx.src.size, 4));
  const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4;
  const lower = fileName.toLowerCase();

  if (isMobi(ctx.src)) return ingestMobi(ctx);

  if (isZip) {
    const zip = ZipArchive.open(ctx.src);
    if (zip.find('META-INF/container.xml') || [...zip.entries.keys()].some((n) => n.toLowerCase().endsWith('.opf'))) {
      return ingestEpub(ctx, zip);
    }
    const fb2 = [...zip.entries.values()].find((e) => e.name.toLowerCase().endsWith('.fb2'));
    if (fb2) return ingestFb2(ctx, zip, fb2);
    throw new BookError('This archive has no EPUB or FB2 book inside.');
  }
  if (lower.endsWith('.fb2') || looksLikeFb2(ctx.src.read(0, Math.min(ctx.src.size, 1024)))) return ingestFb2(ctx);
  return ingestTxt(ctx);
}

function looksLikeFb2(head: Uint8Array): boolean {
  let s = '';
  for (let i = 0; i < head.length; i++) if (head[i]) s += String.fromCharCode(head[i]);
  return /<FictionBook/i.test(s);
}

export function titleFromFileName(name: string): string {
  return name.replace(/\.(fb2\.zip|epub|fb2|txt|zip|mobi|azw3|azw|prc)$/i, '').replace(/[_]+/g, ' ').trim() || 'Untitled';
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
