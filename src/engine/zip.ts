// Random-access ZIP reader. EPUB and .fb2.zip files are ZIPs; we read only
// the central directory up front and then individual entries on demand, so a
// 500 MB EPUB full of images costs the same to open as a 1 MB one.

import { Inflate, inflateSync } from 'fflate';
import { BookError, type ByteSource, READ_SLICE } from './io';
import { decodeUtf8, looksLikeUtf8 } from './decode';

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  /** Offset of the local file header. */
  offset: number;
}

/**
 * Largest entry read whole into memory (package files, tables of contents,
 * images). The size comes from the file itself, so a damaged or hostile one
 * claiming 4 GB must be refused before anything is allocated.
 */
export const MAX_READ_BYTES = 64 * 1024 * 1024;
/** Largest entry streamed (a chapter); the biggest real ones are tens of MB. */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
/** How far a streamed entry may inflate past the size it declares before it counts as a zip bomb. */
const SIZE_SLACK = 1024 * 1024;

const TOO_BIG = 'This book is damaged: part of it is far bigger than a book can be.';

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function u16(b: Uint8Array, o: number) {
  return b[o] | (b[o + 1] << 8);
}
function u32(b: Uint8Array, o: number) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
}
function u64(b: Uint8Array, o: number) {
  return u32(b, o) + u32(b, o + 4) * 0x100000000;
}

export class ZipArchive {
  readonly entries = new Map<string, ZipEntry>();

  private constructor(private src: ByteSource) {}

  static open(src: ByteSource): ZipArchive {
    const zip = new ZipArchive(src);
    zip.readDirectory();
    return zip;
  }

  private readDirectory() {
    const size = this.src.size;
    const tailLen = Math.min(size, 65557);
    const tail = this.src.read(size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (u32(tail, i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a ZIP file (no end of central directory)');
    let count = u16(tail, eocd + 10);
    let cdSize = u32(tail, eocd + 12);
    let cdOffset = u32(tail, eocd + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) {
      // ZIP64: the locator sits right before the EOCD record.
      const loc = eocd - 20;
      if (loc >= 0 && u32(tail, loc) === ZIP64_LOCATOR_SIG) {
        const rec = this.src.read(u64(tail, loc + 8), 56);
        count = u64(rec, 32);
        cdSize = u64(rec, 40);
        cdOffset = u64(rec, 48);
      }
    }
    const cd = this.src.read(cdOffset, cdSize);
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (u32(cd, p) !== CD_SIG) break;
      const flags = u16(cd, p + 8);
      const method = u16(cd, p + 10);
      let compressedSize = u32(cd, p + 20);
      let size = u32(cd, p + 24);
      const nameLen = u16(cd, p + 28);
      const extraLen = u16(cd, p + 30);
      const commentLen = u16(cd, p + 32);
      let offset = u32(cd, p + 42);
      const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
      // Bit 11 says UTF-8, but many tools write UTF-8 names without it; legacy
      // code-page names almost never form valid UTF-8.
      const name = flags & 0x800 || looksLikeUtf8(nameBytes) ? decodeUtf8(nameBytes) : latin1(nameBytes);
      // ZIP64 extra field carries the real sizes/offset when the 32-bit ones are maxed out.
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = u16(cd, e);
        const len = u16(cd, e + 2);
        if (id === 1) {
          let q = e + 4;
          if (size === 0xffffffff) {
            size = u64(cd, q);
            q += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = u64(cd, q);
            q += 8;
          }
          if (offset === 0xffffffff) offset = u64(cd, q);
        }
        e += 4 + len;
      }
      if (!name.endsWith('/')) this.entries.set(name, { name, method, compressedSize, size, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  /** Look up an entry by path, tolerating case differences (common in sloppy EPUBs). */
  find(path: string): ZipEntry | undefined {
    const direct = this.entries.get(path);
    if (direct) return direct;
    const lower = path.toLowerCase();
    for (const [k, v] of this.entries) if (k.toLowerCase() === lower) return v;
    return undefined;
  }

  dataOffset(e: ZipEntry): number {
    const h = this.src.read(e.offset, 30);
    if (u32(h, 0) !== LOCAL_SIG) throw new Error(`Bad local header for ${e.name}`);
    return e.offset + 30 + u16(h, 26) + u16(h, 28);
  }

  /** Read and decompress a whole entry. Use for small files (OPF, NCX, images). */
  read(e: ZipEntry): Uint8Array {
    if (e.size > MAX_READ_BYTES || e.compressedSize > MAX_READ_BYTES) throw new BookError(TOO_BIG);
    const data = this.src.read(this.dataOffset(e), e.compressedSize);
    if (e.method === 0) return data;
    if (e.method === 8) return inflateSync(data, { out: new Uint8Array(e.size) });
    throw new Error(`Unsupported compression method ${e.method}`);
  }

  /**
   * Stream an entry's decompressed bytes in slices. `onData` gets each slice;
   * `between` is awaited after every compressed slice read, so long entries
   * don't freeze the app.
   */
  async stream(e: ZipEntry, onData: (bytes: Uint8Array) => void, between?: (doneFraction: number) => Promise<void>) {
    const start = this.dataOffset(e);
    const total = e.compressedSize;
    // Real entries inflate to the size they declare; one that keeps going is a
    // zip bomb that would fill the phone with converted text.
    const limit = Math.min(MAX_ENTRY_BYTES, e.size + SIZE_SLACK);
    if (e.size > MAX_ENTRY_BYTES) throw new BookError(TOO_BIG);
    let out = 0;
    let inflater: Inflate | null = null;
    if (e.method === 8)
      inflater = new Inflate((chunk) => {
        out += chunk.length;
        if (out > limit) throw new BookError(TOO_BIG);
        onData(chunk);
      });
    else if (e.method !== 0) throw new Error(`Unsupported compression method ${e.method}`);
    for (let pos = 0; pos < total; ) {
      const n = Math.min(READ_SLICE, total - pos);
      const bytes = this.src.read(start + pos, n);
      pos += n;
      if (inflater) inflater.push(bytes, pos >= total);
      else onData(bytes);
      if (between) await between(pos / total);
    }
    if (total === 0 && inflater) inflater.push(new Uint8Array(0), true);
  }
}

/** Static helper for raw reads of a stored/deflated entry located by manifest data. */
export function readZipData(src: ByteSource, offset: number, compressedSize: number, size: number, method: number): Uint8Array {
  if (size > MAX_READ_BYTES || compressedSize > MAX_READ_BYTES) throw new BookError(TOO_BIG);
  const h = src.read(offset, 30);
  const start = offset + 30 + u16(h, 26) + u16(h, 28);
  const data = src.read(start, compressedSize);
  if (method === 0) return data;
  return inflateSync(data, { out: new Uint8Array(size) });
}

function latin1(b: Uint8Array) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

