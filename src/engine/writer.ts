// Collects inline text into blocks and blocks into chunk files.

import type { BookSink } from './io';
import { type Block, type BlockKind, LINK, type Position, type Run, SUB, SUP, type TocEntry, blockLength, makeRun, runLink, runStyle, runText, sliceRuns } from './types';

/** Target characters per chunk file (~10-15 pages). */
export const CHUNK_CHARS = 30_000;
/** Most blocks per chunk file (many short lines: a contents list, verse). */
export const CHUNK_BLOCKS = 600;
/** Paragraphs longer than this are split so no single text view is ever huge. */
export const MAX_BLOCK = 2_000;

const WS = /[ \t\n\r\f\v]+/g;
// (Two spaces are looked for with indexOf: an alternation is twice as slow in Hermes.)
const NEEDS_COLLAPSE = /[\t\n\r\f\v]/;
// Combining marks: text written decomposed (as macOS tools often save it) needs composing.
const COMBINING = /[\u0300-\u036f\u0483-\u0489\u1100-\u11ff\u1dc0-\u1dff\u20d0-\u20ff\u3099\u309a\ufe20-\ufe2f]/;

// Hot paths below avoid regexes where a char check will do: Hermes has no JIT
// and this code runs once per text node of a possibly 100 MB book.
function isWs(c: number) {
  return c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 11;
}

/**
 * Text as it's stored: composed (NFC), so the same word is the same
 * characters whoever made the file and search finds it, and without NUL
 * characters, which would cut the text short where it's handed on.
 */
export function cleanText(s: string, composed = false): string {
  if (s.indexOf('\0') >= 0) s = s.split('\0').join('\ufffd');
  return !composed && COMBINING.test(s) ? s.normalize('NFC') : s;
}

// Page space, measured in lines of body text on a phone held upright (about
// 36 characters each), so that pages per weight hardly vary from chunk to
// chunk: a paragraph takes whole lines, a heading its bigger lines and the
// space around it, a picture a good part of a page. (Characters alone would
// make a chunk of short lines or pictures look many times shorter than it is.)
const LINE_CHARS = 36;
/** A picture of unknown size: about half a page. */
const IMAGE_LINES = 12;
// The page of a phone held upright, in CSS pixels at the reader's default text size.
const COLUMN_PX = 340;
const PAGE_PX = 680;
const LINE_PX = 29;

/** Lines a picture `w` × `h` pixels takes: shown at most a column wide and a page high, as the reader page does. */
export function pictureLines(w: number, h: number): number {
  return Math.max(1, Math.min(PAGE_PX, h * Math.min(1, COLUMN_PX / w)) / LINE_PX);
}

/** Characters of text sampled from a chunk for guessing the language. */
const SAMPLE_CHARS = 1000;

/** Lines the runs' text takes at `perLine` characters a line, each forced line break starting a new one. */
function linesOf(runs: Run[], perLine: number): number {
  let lines = 0;
  let line = 0;
  for (const r of runs) {
    const t = runText(r);
    let from = 0;
    for (let nl = t.indexOf('\n'); nl >= 0; nl = t.indexOf('\n', from)) {
      lines += Math.max(1, Math.ceil((line + nl - from) / perLine));
      line = 0;
      from = nl + 1;
    }
    line += t.length - from;
  }
  return lines + Math.max(1, Math.ceil(line / perLine));
}

/** How much page space a block takes, in lines (see LINE_CHARS). */
export function blockWeight(b: Block): number {
  switch (b.k) {
    case 'img':
      return IMAGE_LINES;
    case 'sp':
    case 'hr':
      return 1;
    case 'h': {
      // Bigger letters, and space above and below (look.ts): level 1 is 1.45 times the body size.
      const level = b.l ?? 1;
      const scale = level === 1 ? 1.45 : level === 2 ? 1.3 : level === 3 ? 1.15 : 1.05;
      const lines = linesOf(b.r ?? [], LINE_CHARS / scale) * scale * 0.87;
      return b.c ? lines : lines + (level <= 2 ? 2.1 : 1.6);
    }
    case 'pre':
      // Smaller but wider (monospaced) letters on shorter lines.
      return linesOf(b.r ?? [], LINE_CHARS) * 0.74;
    case 'q':
    case 'v':
      return linesOf(b.r ?? [], LINE_CHARS * 0.93);
    default:
      return linesOf(b.r ?? [], LINE_CHARS);
  }
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
  /** Page space of each chunk written (Manifest.weights). */
  weights: number[] = [];
  /** The chunks after the first that start a chapter, not cut for size (Manifest.opens). */
  opens: number[] = [];
  /** Level 1-2 headings, used as a table of contents when the book has none. */
  headings: TocEntry[] = [];

  private chunk: Block[] = [];
  private chunkChars = 0;
  private chunkWeight = 0;
  /** Text from the start of every `sampleStride`-th chunk, for telling the book's language. */
  private samples: string[] = [];
  private sampleStride = 1;
  private sample = '';

  private kind: BlockKind = 'p';
  private level = 0;
  private align: 'c' | 'r' | undefined;
  private runs: PendingRun[] = [];
  private curLen = 0;
  private pendingSpace = false;
  /** The text so far ends with a line break: whitespace after it is source indentation. */
  private lineStart = false;
  private continuation = false;
  private wantChunkBreak = false;
  /** Places marked in the block being built, at `at` characters into its text so far (in text order). */
  private marks: { place: Position; at: number }[] = [];
  /** A chapter starts with the next block: the chunk it starts (or begins) opens a chapter. */
  private opening = false;
  /** The chunk being filled opens a chapter. */
  private chunkOpens = false;

  /**
   * `composed`: the text can't hold combining marks (it's decoded from a
   * one-byte encoding), so it needn't be checked for them.
   */
  constructor(
    private sink: BookSink,
    private composed = false,
  ) {}

  /** Index the block currently being built (or the next one) will get. */
  get blockIndex() {
    return this.totalBlocks;
  }

  /** The block being built has text in it already. */
  get inBlock() {
    return this.curLen > 0;
  }

  /**
   * This place inside the block being built (an element with an id begins
   * here): its block, and the offset in that block's text of the character
   * that follows (the block's end if none does). Filled in when the block is
   * written, as a long paragraph may be split by then. Null when no text is
   * waiting: the place is the start of the next block, blockIndex.
   */
  mark(): Position | null {
    if (this.curLen === 0) return null;
    const place = { b: this.totalBlocks, o: 0 };
    this.marks.push({ place, at: this.curLen });
    return place;
  }

  /** Kind used for text that follows. Ends the current block if the kind changes. */
  setKind(kind: BlockKind, level = 0) {
    if (kind !== this.kind || level !== this.level) {
      this.endBlock();
      this.kind = kind;
      this.level = level;
    }
  }

  /** Alignment (from the book's styles) of text that follows. Ends the current block if it changes. */
  setAlign(align: 'c' | 'r' | undefined) {
    if (align !== this.align) {
      this.endBlock();
      this.align = align;
    }
  }

  /** Add inline text. `link` marks it as part of an internal link (e.g. a footnote reference). */
  text(s: string, style = 0, link?: string) {
    if (!s) return;
    if (s.indexOf('\u00ad') >= 0) s = s.split('\u00ad').join('');
    s = cleanText(s, this.composed);
    // Text cut between a letter and its accent (where a slice of the file ended): compose them.
    if (this.curLen > 0 && !this.composed && !this.pendingSpace && COMBINING.test(s[0])) {
      let i = 1;
      while (i < s.length && COMBINING.test(s[i])) i++;
      this.composeTail(s.slice(0, i));
      s = s.slice(i);
      if (!s) return;
    }
    if (this.kind === 'pre') {
      this.append(s.replace(/\r\n?/g, '\n'), style, link);
      return;
    }
    const lead = isWs(s.charCodeAt(0));
    const trail = isWs(s.charCodeAt(s.length - 1));
    let core = s.indexOf('  ') >= 0 || NEEDS_COLLAPSE.test(s) ? s.replace(WS, ' ') : s;
    // After collapsing there is at most one space at each end.
    const a = core.charCodeAt(0) === 32 ? 1 : 0;
    const b = core.length > a && core.charCodeAt(core.length - 1) === 32 ? core.length - 1 : core.length;
    if (a || b < core.length) core = core.slice(a, b);
    if (!core) {
      if (lead && this.curLen > 0 && !this.lineStart) this.pendingSpace = true;
      return;
    }
    // The gap belongs to the text before it, so a space never turns italic or bold.
    // (Except superscript/subscript: a raised space after a note number looks odd.)
    // No gap at the start of a line: that's the source file's indentation.
    if ((lead || this.pendingSpace) && this.curLen > 0 && !this.lineStart) this.append(' ', this.runs[this.runs.length - 1].style & ~(SUP | SUB));
    this.append(core, style, link);
    this.pendingSpace = trail;
  }

  /** Join combining marks to the end of the text so far, composed (NFC). */
  private composeTail(marks: string) {
    const last = this.runs[this.runs.length - 1];
    const tail = last.text.slice(-4);
    const composed = (tail + marks).normalize('NFC');
    last.text = last.text.slice(0, last.text.length - tail.length) + composed;
    this.curLen += composed.length - tail.length;
    for (let i = this.marks.length - 1; i >= 0 && this.marks[i].at > this.curLen; i--) this.marks[i].at = this.curLen;
  }

  /** Hard line break inside the current block. */
  lineBreak() {
    if (this.curLen > 0) {
      this.append('\n', 0);
      this.lineStart = true;
    }
    this.pendingSpace = false;
  }

  endBlock() {
    this.pendingSpace = false;
    this.lineStart = false;
    if (this.curLen === 0) return;
    const pending = this.runs;
    const first = pending[0].text;
    const last = pending[pending.length - 1].text;
    let runs: Run[] = pending.map((r) => makeRun(r.text, r.style, r.link));
    let len = this.curLen;
    let start = 0;
    // Only blocks starting or ending in whitespace (line breaks, <pre>) need trimming.
    if (isWs(first.charCodeAt(0)) || isWs(last.charCodeAt(last.length - 1))) {
      const text = runs.map(runText).join('');
      start = text.search(/\S/);
      if (start < 0) {
        this.resetCurrent();
        this.continuation = false;
        return;
      }
      const end = text.replace(/\s+$/, '').length;
      runs = sliceRuns(runs, start, end);
      len = end - start;
    }
    if (this.marks.length) this.place(Infinity, start, len);
    this.commit(this.makeBlock(runs), len);
    this.resetCurrent();
    this.continuation = false;
  }

  /** A picture; `lines`: the page space it takes, when its size is known (pictureLines). */
  image(key: string, lines?: number) {
    this.endBlock();
    this.commit({ k: 'img', s: key }, 1, lines);
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
    // (Also when the chunk before was just filled up: the next one still starts a chapter.)
    this.opening = true;
  }

  finish() {
    this.endBlock();
    this.flushChunk();
  }

  /** Some of the book's text, from all through it: up to about 50 KB. */
  textSample(): string {
    return this.samples.join(' ');
  }

  private makeBlock(runs: Run[]): Block {
    const b: Block = { k: this.kind, r: runs };
    if (this.kind === 'h') b.l = this.level || 1;
    if (this.continuation) b.c = 1;
    if (this.align) b.a = this.align;
    return b;
  }

  private append(s: string, style: number, link?: string) {
    // A place marked where a gap or line break now goes is where the next word starts.
    if (this.marks.length && isWs(s.charCodeAt(0))) {
      let n = 1;
      while (n < s.length && isWs(s.charCodeAt(n))) n++;
      for (let i = this.marks.length - 1; i >= 0 && this.marks[i].at === this.curLen; i--) this.marks[i].at += n;
    }
    const last = this.runs[this.runs.length - 1];
    if (last && last.style === style && last.link === link) last.text += s;
    else this.runs.push({ text: s, style, link });
    this.curLen += s.length;
    this.lineStart = false;
    if (this.curLen > MAX_BLOCK + MAX_BLOCK / 2) this.splitLong();
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
      if (this.marks.length) this.place(cut, pos, cut - pos);
      this.commit(this.makeBlock(piece), cut - pos);
      this.continuation = true;
      pos = cut;
    }
    for (const m of this.marks) m.at -= pos;
    const rest = sliceRuns(runs, pos, text.length);
    this.runs = rest.map((r) => ({ text: runText(r), style: runStyle(r) & ~LINK, link: runLink(r) }));
    this.curLen = text.length - pos;
  }

  private resetCurrent() {
    this.runs = [];
    this.curLen = 0;
    // (Marks left in text that was only spaces: at the start of the next block.)
    for (const m of this.marks) m.place.b = this.totalBlocks;
    this.marks = [];
  }

  /**
   * The marks before character `before` of the text being built are in the
   * block about to be written, which holds that text from `start` on and is
   * `len` characters long.
   */
  private place(before: number, start: number, len: number) {
    const left: { place: Position; at: number }[] = [];
    for (const m of this.marks) {
      if (m.at >= before) left.push(m);
      else {
        m.place.b = this.totalBlocks;
        m.place.o = Math.max(0, Math.min(len, m.at - start));
      }
    }
    this.marks = left;
  }

  private commit(b: Block, len = blockLength(b), weight?: number) {
    if (this.wantChunkBreak) {
      this.wantChunkBreak = false;
      this.flushChunk();
    }
    if (b.k === 'h' && (b.l ?? 1) <= 2 && !b.c) {
      const t = b.r!.map(runText).join('').replace(/\s+/g, ' ').trim();
      if (t) this.headings.push({ t: t.length > 120 ? t.slice(0, 117) + '…' : t, l: (b.l ?? 1) - 1, b: this.totalBlocks });
    }
    if (!this.chunk.length) {
      this.chunks.push([this.totalBlocks, this.totalChars]);
      this.chunkOpens = this.opening && this.chunks.length > 1;
    }
    this.opening = false;
    len = Math.max(len, 1);
    this.chunk.push(b);
    this.chunkChars += len;
    this.chunkWeight += weight ?? blockWeight(b);
    if (b.r && this.sample.length < SAMPLE_CHARS && (this.chunks.length - 1) % this.sampleStride === 0) {
      for (const r of b.r) this.sample += runText(r);
      this.sample += ' ';
    }
    this.totalChars += len;
    this.totalBlocks++;
    if (this.chunkChars >= CHUNK_CHARS || this.chunk.length >= CHUNK_BLOCKS) this.flushChunk();
  }

  private flushChunk() {
    if (!this.chunk.length) return;
    const [firstBlock, firstChar] = this.chunks[this.chunks.length - 1];
    const weight = Math.max(1, Math.round(this.chunkWeight));
    this.weights.push(weight);
    const index = this.chunks.length - 1;
    if (this.chunkOpens) this.opens.push(index);
    this.sink.writeChunk(index, JSON.stringify({ b: this.chunk }), {
      firstBlock,
      firstChar,
      blocks: this.chunk.length,
      chars: this.chunkChars,
      weight,
      ...(this.chunkOpens ? { opens: true } : {}),
    });
    this.chunk = [];
    this.chunkChars = 0;
    this.chunkWeight = 0;
    if (this.sample) {
      this.samples.push(this.sample.slice(0, SAMPLE_CHARS));
      this.sample = '';
      // Keep it spread over the book: past 48 samples, every other one goes and the stride doubles.
      if (this.samples.length > 48) {
        this.samples = this.samples.filter((_, i) => i % 2 === 0);
        this.sampleStride *= 2;
      }
    }
  }
}
