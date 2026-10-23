// Platform-neutral I/O contracts, so the engine runs the same in the app
// (expo-file-system) and in Node tests.

export interface ByteSource {
  readonly size: number;
  /** Read up to `length` bytes at `offset`. */
  read(offset: number, length: number): Uint8Array;
}

/** Where a chunk sits in the book, reported as soon as it's written. */
export interface ChunkInfo {
  firstBlock: number;
  firstChar: number;
  blocks: number;
  chars: number;
}

export interface BookSink {
  writeChunk(index: number, json: string, info: ChunkInfo): void;
  writeImage(name: string, data: Uint8Array): void;
  writeImageBase64(name: string, base64: string): void;
}

export interface IngestContext {
  src: ByteSource;
  sink: BookSink;
  /** Fraction 0..1 of the work done. */
  progress(fraction: number): void;
  /** Let the UI breathe. Called between slices of work. */
  pause(): Promise<void>;
  /** Fallback title when the file carries none (usually the file name). */
  fallbackTitle: string;
  /** Called as soon as title/author/cover are known, before the text is done. */
  meta?(info: BookMeta): void;
}

export interface BookMeta {
  title?: string;
  author?: string;
  /** File name of the extracted cover image. */
  coverFile?: string;
}

/** A problem with the book itself, already worded for the reader: shown as is. */
export class BookError extends Error {}

/** Why a copy-protected book can't be opened, in the same words for every format. */
export const DRM_MESSAGE = 'This book is copy-protected (DRM), so it can only be read in the app of the store it came from.';

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
  }
}

/** Bytes read per slice. Big enough to be efficient, small enough to stay responsive. */
export const READ_SLICE = 64 * 1024;

export function concatBytes(parts: Uint8Array[], total?: number): Uint8Array {
  const n = total ?? parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
