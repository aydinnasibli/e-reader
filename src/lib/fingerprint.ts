// A cheap identity for a book file, to notice the same book being added
// twice: its size plus a hash of its first and last 64 KB. Reading the whole
// file would take seconds for a big book; the ends are enough to tell books
// apart, and a different copy of the same book (another edition, another
// download) is a different book.

import type { ByteSource } from '@/engine/io';

const SAMPLE = 64 * 1024;

/** 53-bit string hash (cyrb53) of the bytes. */
export function hashBytes(bytes: Uint8Array, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function fingerprintOf(src: ByteSource): string {
  const head = src.read(0, SAMPLE);
  const tail = src.size > SAMPLE ? src.read(Math.max(SAMPLE, src.size - SAMPLE), SAMPLE) : new Uint8Array(0);
  return `${src.size}:${hashBytes(head)}:${hashBytes(tail, 1)}`;
}
