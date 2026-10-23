// Full-text search over a converted book, chunk by chunk in the background.
// Results stream in as they're found, so the first hits in a 100 MB book show
// up immediately while the rest is still being searched.

import { type Block, type ChunkFile, blockText } from '@/engine/types';
import { chunkFile } from '@/lib/storage';
import type { BookData } from './book';

export interface Hit {
  b: number;
  /** Offset of the match in the block's text. */
  o: number;
  len: number;
  before: string;
  match: string;
  after: string;
}

export const MAX_HITS = 1000;
const CONTEXT = 40;

/** Case-folding that keeps string length, so offsets stay valid. */
export function fold(s: string): string {
  const low = s.toLowerCase();
  if (low.length === s.length) return low.replace(/ё/g, 'е');
  // Some capitals lowercase to two characters (Turkish İ -> i + dot); fold
  // those one by one so every offset still lines up with the original text.
  let out = '';
  for (const ch of s) {
    let l = ch.toLowerCase();
    if (l.length !== ch.length) l = ch === 'İ' ? 'i' : ch;
    out += l === 'ё' ? 'е' : l;
  }
  return out;
}

/** All matches of an already-folded query in one block. */
export function findInBlock(block: Block, b: number, q: string, out: Hit[], limit: number) {
  if (!block.r) return;
  const text = blockText(block);
  const hay = fold(text);
  for (let i = hay.indexOf(q); i >= 0 && out.length < limit; i = hay.indexOf(q, i + q.length)) {
    const from = Math.max(0, i - CONTEXT);
    const to = Math.min(text.length, i + q.length + CONTEXT);
    out.push({
      b,
      o: i,
      len: q.length,
      before: (from > 0 ? '…' : '') + text.slice(from, i).replace(/\s+/g, ' '),
      match: text.slice(i, i + q.length),
      after: text.slice(i + q.length, to).replace(/\s+/g, ' ') + (to < text.length ? '…' : ''),
    });
  }
}

export interface SearchProgress {
  hits: Hit[];
  /** Fraction of chunks searched. */
  done: number;
  finished: boolean;
}

/** Start searching; returns a function that cancels the search. */
export function searchBook(book: BookData, query: string, onUpdate: (p: SearchProgress) => void): () => void {
  const q = fold(query.trim());
  let cancelled = false;
  if (q.length < 2) {
    onUpdate({ hits: [], done: 1, finished: true });
    return () => {};
  }
  (async () => {
    const hits: Hit[] = [];
    let lastPublish = 0;
    const count = book.chunkCount;
    for (let i = 0; i < count && !cancelled && hits.length < MAX_HITS; i++) {
      // Every chunk is parsed (well under a millisecond each): matching the raw
      // JSON would miss words split across style runs, like a bold first letter.
      // A missing or damaged chunk is skipped; the rest of the book is still searched.
      let blocks: Block[];
      try {
        const raw = await chunkFile(book.entry.id, i).text();
        if (cancelled) return;
        blocks = (JSON.parse(raw) as ChunkFile).b;
        if (!Array.isArray(blocks)) continue;
      } catch {
        continue;
      }
      const first = book.chunkStart(i);
      for (let k = 0; k < blocks.length && hits.length < MAX_HITS; k++) findInBlock(blocks[k], first + k, q, hits, MAX_HITS);
      const now = Date.now();
      if (now - lastPublish > 150) {
        lastPublish = now;
        onUpdate({ hits: hits.slice(), done: (i + 1) / count, finished: false });
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (!cancelled) onUpdate({ hits, done: 1, finished: true });
  })();

  return () => {
    cancelled = true;
  };
}
