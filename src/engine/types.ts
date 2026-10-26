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
/** Part of an internal link (footnote reference); the target is the run's third element. */
export const LINK = 32;
/** Small capitals (from the book's own styles). */
export const SMALLCAPS = 64;

/** A run of text: plain string, [text, style bits], or [text, style bits, link target]. */
export type Run = string | [string, number] | [string, number, string];

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
  /** Alignment the book's own styles give it: centred or right. */
  a?: 'c' | 'r';
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
  | { pdb: [offset: number, length: number]; ext: string }
  | { file: string };

export type BookFormat = 'epub' | 'fb2' | 'txt' | 'mobi' | 'azw3';

/**
 * Version of the converters' output, saved in each book's manifest. Bump it
 * whenever the same file would come out as different blocks (split, merged,
 * dropped or reordered): highlights, bookmarks and reading positions are
 * block numbers, so a book converted again by a newer version needs its
 * annotations moved along (by their saved text) or they land elsewhere.
 */
export const ENGINE_VERSION = 2;

export interface Manifest {
  /** ENGINE_VERSION of the converter that made it. */
  v: number;
  format: BookFormat;
  title: string;
  author: string;
  /** Two-letter language code ('en', 'tr'): from the book's metadata, checked against its text, or guessed. */
  lang?: string;
  totalBlocks: number;
  totalChars: number;
  /** One entry per chunk: [first global block index, chars before the chunk]. */
  chunks: [number, number][];
  /**
   * One per chunk: how much page space it takes, in estimated lines, so that
   * pages per weight vary far less between chunks than pages per character
   * (a contents chunk of short lines, a chunk of pictures). Page numbers use it.
   */
  weights?: number[];
  /**
   * The chunks that start a chapter (cut where the book starts one, not for
   * size): each starts on a page of its own, never going on from the chunk
   * before on its last page (Chunk.joins).
   */
  opens?: number[];
  /** Link targets that aren't notes (e.g. a note's link back to its reference) -> the block they're in. */
  anchors?: Record<string, number>;
  /**
   * Where in its block an anchor is, when it isn't at the block's start: the
   * character offset (as blockText counts) of the anchored element's first
   * character. A link then lands on the page the place is on, not the one
   * its paragraph starts on (a note's way back to its mark). An anchor not
   * listed, like every anchor of a book converted before it, is at the
   * block's start: 0. (Most are, and listing them would make the manifest a
   * half bigger.)
   */
  anchorOffsets?: Record<string, number>;
  toc: TocEntry[];
  images: Record<string, ImageRef>;
  cover?: string;
  /** Link target -> [first block, end block) of the note/section it points at. */
  notes?: Record<string, [number, number]>;
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

export function runLink(r: Run): string | undefined {
  return typeof r === 'string' ? undefined : r[2];
}

export function makeRun(text: string, style: number, link?: string): Run {
  if (link) return [text, style | LINK, link];
  return style ? [text, style] : text;
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
    out.push(makeRun(piece, runStyle(r) & ~LINK, runLink(r)));
  }
  return out;
}
