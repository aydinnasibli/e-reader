// The normalized book format every source format is converted into.
//
// A book is a flat sequence of blocks (paragraphs, headings, images...),
// stored on disk in chunks of a few tens of KB. The reader only ever loads the
// chunks around the current position, which is what keeps enormous books fast.

/** Inline style bits. */
export const BOLD = 1;
export const ITALIC = 2;
export const MONO = 4;
export const SUP = 8;
export const SUB = 16;

/** A run of text: plain string, or [text, style bits]. */
export type Run = string | [string, number];

export type BlockKind =
  | 'p' // paragraph
  | 'h' // heading, level in `l`
  | 'q' // quote / epigraph / cite
  | 'v' // verse line
  | 'pre' // preformatted
  | 'sp' // empty line
  | 'hr' // separator
  | 'img'; // image, key into Manifest.images in `s`

export interface Block {
  k: BlockKind;
  r?: Run[];
  /** Heading level 1..6. */
  l?: number;
  /** Continuation of the previous block (a long paragraph split for speed): no indent, no gap. */
  c?: 1;
  /** Image key. */
  s?: string;
}

export interface TocEntry {
  /** Title */
  t: string;
  /** Depth, 0-based */
  l: number;
  /** Global block index */
  b: number;
}

/** Where an image lives: inside the source zip, or already extracted to a file. */
export type ImageRef =
  | { zip: [offset: number, compressedSize: number, size: number, method: number]; ext: string }
  | { file: string };

export type BookFormat = 'epub' | 'fb2' | 'txt';

export interface Manifest {
  v: 1;
  format: BookFormat;
  title: string;
  author: string;
  lang?: string;
  totalBlocks: number;
  totalChars: number;
  /** One entry per chunk: [first global block index, chars before the chunk]. */
  chunks: [number, number][];
  toc: TocEntry[];
  images: Record<string, ImageRef>;
  cover?: string;
}

export interface ChunkFile {
  b: Block[];
}

/** A reading position: block index plus character offset within that block. */
export interface Position {
  b: number;
  o: number;
}

export function runText(r: Run): string {
  return typeof r === 'string' ? r : r[0];
}

export function runStyle(r: Run): number {
  return typeof r === 'string' ? 0 : r[1];
}

export function blockText(b: Block): string {
  if (!b.r) return '';
  let s = '';
  for (const r of b.r) s += runText(r);
  return s;
}

/** Length used for progress math; non-text blocks count as one character. */
export function blockLength(b: Block): number {
  if (!b.r) return 1;
  let n = 0;
  for (const r of b.r) n += runText(r).length;
  return Math.max(n, 1);
}

/** Cut runs to the [start, end) character range. */
export function sliceRuns(runs: Run[], start: number, end: number): Run[] {
  const out: Run[] = [];
  let pos = 0;
  for (const r of runs) {
    const t = runText(r);
    const rs = pos;
    const re = pos + t.length;
    pos = re;
    if (re <= start) continue;
    if (rs >= end) break;
    const piece = t.slice(Math.max(0, start - rs), Math.min(t.length, end - rs));
    if (!piece) continue;
    const st = runStyle(r);
    out.push(st ? [piece, st] : piece);
  }
  return out;
}
