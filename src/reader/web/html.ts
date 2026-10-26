// A chunk's blocks as HTML for the page. Each block element carries data-b
// and holds exactly the block's drawn text (look.ts drawn(): the indent and
// soft hyphens included), so offsets on the page are drawn offsets.
//
// A long paragraph is stored as several blocks (the first, then continuation
// blocks, `c`): they're drawn as one paragraph, a wrapper (data-w) holding
// each block as an inline part, so its lines run on where the blocks meet.

import { BOLD, type Block, ITALIC, MONO, type Run, SMALLCAPS, SUB, SUP, runLink, runStyle, runText } from '@/engine/types';
import { CHUNK_BLOCKS, CHUNK_CHARS } from '@/engine/writer';
import type { ReaderSettings } from '@/lib/settings';
import type { ImageInfo } from '../book';
import { drawn, lookOf } from '../look';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\r': ' ' };
/**
 * Text as HTML, every character still one character in the page, so offsets
 * after it stay put: a NUL (which the HTML parser drops) becomes U+FFFD, a
 * carriage return (which it merges into a line feed after it) a space.
 */
export const escapeHtml = (s: string) => (s.indexOf('\0') >= 0 ? s.split('\0').join('\uFFFD') : s).replace(/[&<>"\r]/g, (c) => ENTITIES[c]);

function runHtml(r: Run): string {
  const text = escapeHtml(runText(r));
  const bits = runStyle(r);
  const link = runLink(r);
  const cls = [bits & BOLD && 'b', bits & ITALIC && 'i', bits & MONO && 'mono', bits & SUP && 'sup', bits & SUB && 'sub', bits & SMALLCAPS && 'sc', link && 'a'].filter(Boolean);
  if (!cls.length) return text;
  return `<span class="${cls.join(' ')}"${link ? ` data-link="${escapeHtml(link)}"` : ''}>${text}</span>`;
}

/** The class a block's look is styled by (see css.ts). */
export function blockClass(b: Block): string {
  if (b.k === 'h') return `h${Math.min(6, Math.max(1, b.l ?? 1))}`;
  return b.k;
}

/** Its classes: its look, and the alignment the book gives it. */
function classes(b: Block, continued: boolean) {
  return blockClass(b) + (continued ? ' c' : '') + (b.a === 'c' ? ' ac' : b.a === 'r' ? ' ar' : '');
}

const runsHtml = (blk: Block, settings: ReaderSettings, lang: string | undefined) => drawn(blk, lookOf(blk, settings, lang)).runs.map(runHtml).join('');

/** One block as HTML. `image`: its picture, for an image block (null: none to show). */
export function blockHtml(blk: Block, b: number, settings: ReaderSettings, lang: string | undefined, image?: ImageInfo | null): string {
  if (blk.k === 'sp') return `<div data-b="${b}" class="sp"></div>`;
  if (blk.k === 'hr') return `<div data-b="${b}" class="hr"><i></i></div>`;
  if (blk.k === 'img') {
    if (!image) return `<div data-b="${b}" class="img"></div>`;
    const { uri, width, height } = image;
    // Its own shape, never over twice its size, as wide as the column at most and as high as a page (css.ts --page-h).
    const shape = height > 0 ? width / height : 1;
    return `<div data-b="${b}" class="img"><img src="${escapeHtml(uri)}" width="${width}" height="${height}" style="width:min(100%,${width * 2}px,calc(var(--page-h) * ${+shape.toFixed(5)}));height:auto" alt=""></div>`;
  }
  const cls = classes(blk, !!blk.c);
  const tag = blk.k === 'h' ? cls.slice(0, 2) : 'p';
  return `<${tag} data-b="${b}" class="${cls}">${runsHtml(blk, settings, lang)}</${tag}>`;
}

/** A paragraph's blocks (the first, or a continuation going on from the chunk before, then continuations) as one paragraph. */
function paragraphHtml(blocks: Block[], first: number, settings: ReaderSettings, lang: string | undefined): string {
  const parts = blocks.map((blk, k) => `<p data-b="${first + k}">${runsHtml(blk, settings, lang)}</p>`).join('');
  return `<div data-w class="${classes(blocks[0], !!blocks[0].c)}">${parts}</div>`;
}

const isText = (b: Block) => b.k === 'p' || b.k === 'q' || b.k === 'v' || b.k === 'pre' || b.k === 'h';

/** A chunk's blocks (the first one is block `first`), with the pictures of its image blocks. */
export function chunkHtml(blocks: Block[], first: number, settings: ReaderSettings, lang: string | undefined, images: Map<string, ImageInfo | null>): string {
  let out = '';
  for (let k = 0; k < blocks.length; ) {
    const blk = blocks[k];
    let end = k + 1;
    if (isText(blk)) while (end < blocks.length && blocks[end].c && blocks[end].k === blk.k) end++;
    // A paragraph in parts, or the rest of one from the chunk before (which the page may join to it).
    if (end - k > 1 || (k === 0 && blk.c && isText(blk))) out += paragraphHtml(blocks.slice(k, end), first + k, settings, lang);
    else out += blockHtml(blk, first + k, settings, lang, blk.s ? images.get(blk.s) : undefined);
    k = end;
  }
  return out;
}

/** Whether chunk `x` was cut where it was only for its size (chapters always start a chunk of their own). */
function cutForSize(chars: number, blocks: number) {
  // The converter (src/engine/writer.ts) starts a new chunk at CHUNK_CHARS characters or CHUNK_BLOCKS blocks.
  return chars >= CHUNK_CHARS || blocks >= CHUNK_BLOCKS;
}

/**
 * Whether chunk `c` goes on from the chunk before on its last page (Chunk.joins)
 * rather than starting a page of its own: where a chapter was cut into chunks
 * only for size, the chunks of each pair (its first and second, third and
 * fourth...) are laid out as one. Longer runs would make a page depend on
 * chunks the page doesn't have. `opens`: the chunks that start a chapter
 * (Manifest.opens); a book converted before the converter told them has its
 * chapters' starts told from size, where the chunk before ends short of the
 * limit. `chars(x)` and `blocks(x)`: chunk x's size.
 */
export function joinsBefore(c: number, chars: (x: number) => number, blocks: (x: number) => number, opens?: readonly number[]): boolean {
  const chapters = opens && new Set(opens);
  const opensAt = (x: number) => (chapters ? chapters.has(x) : !cutForSize(chars(x - 1), blocks(x - 1)));
  if (c <= 0 || opensAt(c)) return false;
  // Where this run of chunks cut for size starts: the chapter's first chunk.
  let start = c - 1;
  while (start > 0 && !opensAt(start)) start--;
  return (c - start) % 2 === 1;
}
