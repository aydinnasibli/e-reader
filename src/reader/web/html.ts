// A chunk's blocks as HTML for the page. Each block element carries data-b
// and holds exactly the block's drawn text (look.ts drawn(): the indent and
// soft hyphens included), so offsets on the page are drawn offsets.

import { BOLD, type Block, ITALIC, MONO, type Run, SUB, SUP, runLink, runStyle, runText } from '@/engine/types';
import type { ReaderSettings } from '@/lib/settings';
import type { ImageInfo } from '../book';
import { drawn, lookOf } from '../look';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ENTITIES[c]);

function runHtml(r: Run): string {
  const text = escapeHtml(runText(r));
  const bits = runStyle(r);
  const link = runLink(r);
  const cls = [bits & BOLD && 'b', bits & ITALIC && 'i', bits & MONO && 'mono', bits & SUP && 'sup', bits & SUB && 'sub', link && 'a'].filter(Boolean);
  if (!cls.length) return text;
  return `<span class="${cls.join(' ')}"${link ? ` data-link="${escapeHtml(link)}"` : ''}>${text}</span>`;
}

/** The class a block's look is styled by (see css.ts). */
export function blockClass(b: Block): string {
  if (b.k === 'h') return `h${Math.min(6, Math.max(1, b.l ?? 1))}`;
  return b.k;
}

/** One block as HTML. `image`: its picture, for an image block (null: none to show). */
export function blockHtml(blk: Block, b: number, settings: ReaderSettings, lang: string | undefined, image?: ImageInfo | null): string {
  if (blk.k === 'sp') return `<div data-b="${b}" class="sp"></div>`;
  if (blk.k === 'hr') return `<div data-b="${b}" class="hr"><i></i></div>`;
  if (blk.k === 'img') {
    if (!image) return `<div data-b="${b}" class="img"></div>`;
    const { uri, width, height } = image;
    return `<div data-b="${b}" class="img"><img src="${escapeHtml(uri)}" width="${width}" height="${height}" style="max-width:min(100%,${width * 2}px)" alt=""></div>`;
  }
  const d = drawn(blk, lookOf(blk, settings, lang));
  const cls = blockClass(blk) + (blk.c ? ' c' : '');
  const tag = blk.k === 'h' ? cls.slice(0, 2) : 'p';
  return `<${tag} data-b="${b}" class="${cls}">${d.runs.map(runHtml).join('')}</${tag}>`;
}

/** A chunk's blocks (the first one is block `first`), with the pictures of its image blocks. */
export function chunkHtml(blocks: Block[], first: number, settings: ReaderSettings, lang: string | undefined, images: Map<string, ImageInfo | null>): string {
  return blocks.map((blk, k) => blockHtml(blk, first + k, settings, lang, blk.s ? images.get(blk.s) : undefined)).join('');
}
