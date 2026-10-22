// Collects inline text into blocks and blocks into chunk files.

import type { BookSink } from './io';
import { type Block, type BlockKind, LINK, type Run, SUB, SUP, type TocEntry, blockLength, makeRun, runLink, runStyle, runText, sliceRuns } from './types';

/** Target characters per chunk file (~10-15 pages). */
export const CHUNK_CHARS = 30_000;
const CHUNK_BLOCKS = 600;
/** Paragraphs longer than this are split so no single text view is ever huge. */
export const MAX_BLOCK = 2_000;

const WS = /[ \t\n\r\f\v]+/g;
const NEEDS_COLLAPSE = /[\t\n\r\f\v]| {2}/;

// Hot paths below avoid regexes where a char check will do: Hermes has no JIT
// and this code runs once per text node of a possibly 100 MB book.
function isWs(c: number) {
  return c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 11;
}

interface PendingRun {
  text: string;
  style: number;
  link?: string;
}

export class BookWriter {
  totalBlocks = 0;
  totalChars = 0;
  chunks: [number, number][] = [];
  /** Level 1-2 headings, used as a table of contents when the book has none. */
  headings: TocEntry[] = [];

  private chunk: Block[] = [];
  private chunkChars = 0;

  private kind: BlockKind = 'p';
  private level = 0;
  private runs: PendingRun[] = [];
  private curLen = 0;
  private pendingSpace = false;
  private continuation = false;
  private wantChunkBreak = false;

  constructor(private sink: BookSink) {}

  /** Index the block currently being built (or the next one) will get. */
  get blockIndex() {
    return this.totalBlocks;
  }

  /** Kind used for text that follows. Ends the current block if the kind changes. */
  setKind(kind: BlockKind, level = 0) {
    if (kind !== this.kind || level !== this.level) {
      this.endBlock();
      this.kind = kind;
      this.level = level;
    }
  }

  /** Add inline text. `link` marks it as part of an internal link (e.g. a footnote reference). */
  text(s: string, style = 0, link?: string) {
    if (!s) return;
    if (s.indexOf('\u00ad') >= 0) s = s.split('\u00ad').join('');
    if (this.kind === 'pre') {
      this.append(s.replace(/\r\n?/g, '\n'), style, link);
      return;
    }
    const lead = isWs(s.charCodeAt(0));
    const trail = isWs(s.charCodeAt(s.length - 1));
    let core = NEEDS_COLLAPSE.test(s) ? s.replace(WS, ' ') : s;
    // After collapsing there is at most one space at each end.
    const a = core.charCodeAt(0) === 32 ? 1 : 0;
    const b = core.length > a && core.charCodeAt(core.length - 1) === 32 ? core.length - 1 : core.length;
    if (a || b < core.length) core = core.slice(a, b);
    if (!core) {
      if (lead && this.curLen > 0) this.pendingSpace = true;
      return;
    }
    // The gap belongs to the text before it, so a space never turns italic or bold.
    // (Except superscript/subscript: a raised space after a note number looks odd.)
    if ((lead || this.pendingSpace) && this.curLen > 0) this.append(' ', this.runs[this.runs.length - 1].style & ~(SUP | SUB));
    this.append(core, style, link);
    this.pendingSpace = trail;
  }

  /** Hard line break inside the current block. */
  lineBreak() {
    if (this.curLen > 0) this.append('\n', 0);
    this.pendingSpace = false;
  }

  endBlock() {
    this.pendingSpace = false;
    if (this.curLen === 0) return;
    const pending = this.runs;
    const first = pending[0].text;
    const last = pending[pending.length - 1].text;
    let runs: Run[] = pending.map((r) => makeRun(r.text, r.style, r.link));
    let len = this.curLen;
    // Only blocks starting or ending in whitespace (line breaks, <pre>) need trimming.
    if (isWs(first.charCodeAt(0)) || isWs(last.charCodeAt(last.length - 1))) {
      const text = runs.map(runText).join('');
      const start = text.search(/\S/);
      if (start < 0) {
        this.resetCurrent();
        this.continuation = false;
        return;
      }
      const end = text.replace(/\s+$/, '').length;
      runs = sliceRuns(runs, start, end);
      len = end - start;
    }
    this.commit(this.makeBlock(runs), len);
    this.resetCurrent();
    this.continuation = false;
  }

  image(key: string) {
    this.endBlock();
    this.commit({ k: 'img', s: key });
  }

  separator() {
    this.endBlock();
    this.commit({ k: 'hr' });
  }

  emptyLine() {
    this.endBlock();
    this.commit({ k: 'sp' });
  }

  /** A new chapter starts here: begin a fresh chunk so it starts on a new page. */
  chapterBreak() {
    this.endBlock();
    if (this.chunk.length) this.wantChunkBreak = true;
  }

  finish() {
    this.endBlock();
    this.flushChunk();
  }

  private makeBlock(runs: Run[]): Block {
    const b: Block = { k: this.kind, r: runs };
    if (this.kind === 'h') b.l = this.level || 1;
    if (this.continuation) b.c = 1;
    return b;
  }

  private append(s: string, style: number, link?: string) {
    const last = this.runs[this.runs.length - 1];
    if (last && last.style === style && last.link === link) last.text += s;
    else this.runs.push({ text: s, style, link });
    this.curLen += s.length;
    if (this.curLen > MAX_BLOCK + MAX_BLOCK / 2 && this.kind !== 'h') this.splitLong();
  }

  /** Emit full-size pieces of an over-long paragraph, keeping the tail open. */
  private splitLong() {
    const runs = this.runs.map((r) => makeRun(r.text, r.style, r.link));
    const text = runs.map(runText).join('');
    let pos = 0;
    while (text.length - pos > MAX_BLOCK + MAX_BLOCK / 2) {
      let cut = text.lastIndexOf(' ', pos + MAX_BLOCK);
      if (cut <= pos + MAX_BLOCK / 2) {
        cut = pos + MAX_BLOCK;
        // Don't split a surrogate pair (emoji and rare CJK).
        const c = text.charCodeAt(cut - 1);
        if (c >= 0xd800 && c <= 0xdbff) cut--;
      } else cut += 1;
      const piece = sliceRuns(runs, pos, cut);
      this.commit(this.makeBlock(piece), cut - pos);
      this.continuation = true;
      pos = cut;
    }
    const rest = sliceRuns(runs, pos, text.length);
    this.runs = rest.map((r) => ({ text: runText(r), style: runStyle(r) & ~LINK, link: runLink(r) }));
    this.curLen = text.length - pos;
  }

  private resetCurrent() {
    this.runs = [];
    this.curLen = 0;
  }

  private commit(b: Block, len = blockLength(b)) {
    if (this.wantChunkBreak) {
      this.wantChunkBreak = false;
      this.flushChunk();
    }
    if (b.k === 'h' && (b.l ?? 1) <= 2 && !b.c) {
      const t = b.r!.map(runText).join('').replace(/\s+/g, ' ').trim();
      if (t) this.headings.push({ t: t.length > 120 ? t.slice(0, 117) + '…' : t, l: (b.l ?? 1) - 1, b: this.totalBlocks });
    }
    if (!this.chunk.length) this.chunks.push([this.totalBlocks, this.totalChars]);
    len = Math.max(len, 1);
    this.chunk.push(b);
    this.chunkChars += len;
    this.totalChars += len;
    this.totalBlocks++;
    if (this.chunkChars >= CHUNK_CHARS || this.chunk.length >= CHUNK_BLOCKS) this.flushChunk();
  }

  private flushChunk() {
    if (!this.chunk.length) return;
    const [firstBlock, firstChar] = this.chunks[this.chunks.length - 1];
    this.sink.writeChunk(this.chunks.length - 1, JSON.stringify({ b: this.chunk }), {
      firstBlock,
      firstChar,
      blocks: this.chunk.length,
      chars: this.chunkChars,
    });
    this.chunk = [];
    this.chunkChars = 0;
  }
}
