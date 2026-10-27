// Plain text: detect the encoding and how paragraphs are laid out, then stream
// the file line by line. Lines of any length are fine; a 100 MB file with no
// line breaks at all is fed to the writer in slices, never as one string.
//
// Layouts met in the wild: one paragraph per line; paragraphs separated by
// blank lines; paragraphs starting with an indented line; and any of these
// hard-wrapped at a fixed width (Project Gutenberg wraps at about 70), where a
// paragraph ends at a blank line, an indented line, or a short line ending a
// sentence. Verse keeps its line breaks.

import { createDecoder, detectBom, type Encoding, sniffEncoding } from './decode';
import { fold } from './fold';
import { type ByteSource, type IngestContext, READ_SLICE, UNTITLED } from './io';
import { guessLanguage } from './language';
import { ENGINE_VERSION, type Manifest } from './types';
import { BookWriter, cleanText } from './writer';

const HEADING_RE =
  /^(chapter|part|book|volume|letter|prologue|epilogue|introduction|preface|foreword|afterword|appendix|contents|глава|часть|книга|пролог|эпилог|предисловие|послесловие|введение|fəsil|hissə|bolum|kisim|kitap|onsoz|giris|sonsoz|icindekiler|kapitel|teil|chapitre|partie|capitulo|parte|capitolo|rozdział|розділ|частина)(?=$|[\s.:,!?\d…-])/;
// Turkish chapters by ordinal ("Birinci Bölüm", "On İkinci Kısım", "Son Bölüm") or number first ("1. Bölüm", "IV. KISIM").
const TR_ORDINAL =
  /^((on|yirmi|otuz|kirk|elli|altmis|yetmis|seksen|doksan|yuz)\s+)?(birinci|ikinci|ucuncu|dorduncu|besinci|altinci|yedinci|sekizinci|dokuzuncu|onuncu|yirminci|otuzuncu|kirkinci|ellinci|altmisinci|yetmisinci|sekseninci|doksaninci|yuzuncu|son)\s+(bolum|kisim|kitap|perde)(?=$|[\s.:,!?…-])/;
const TR_NUMBERED = /^(\d{1,3}|[ivxlcdm]{1,7})\.?\s*(bolum|kisim|kitap|perde)(?=$|[\s.:,!?…-])/;
const ROMAN_RE = /^[IVXLCDM]{1,8}\.?$/;
const ASCII = /^[\x00-\x7f]*$/;
const SCENE_BREAK_RE = /^(\*\s*){3,}$|^(-\s*){3,}$|^#$/;
const LONG_LINE = 64 * 1024;

function startsIndented(s: string) {
  const c = s.charCodeAt(0);
  return c === 32 || c === 9 || c === 0x3000;
}

const NUMBERED_RE = /^[\s.:—–-]*(\d+|[IVXLCDM]+)(?=$|[\s.:,—–-])/i;
const ORDINAL_TITLE = /^\s*[A-Za-z\u00c0-\u024f\u0400-\u04ff]{1,12}\s*[—–:.]\s*\S/;

/**
 * The heading word or ordinal a line starts with ("Chapter", "Birinci Bölüm",
 * "6. BÖLÜM"), matched folded: capitals, accents and the Turkish dotted and
 * dotless i make no difference. Its length in the line (folding keeps the
 * length, and the longest heading word or ordinal fits in the first 32
 * characters) and its kind ('chapter', 'part', 'bolum'...); null if none.
 */
function headingStart(t: string): { length: number; kind: string } | null {
  const start = t.slice(0, 32);
  const f = ASCII.test(start) ? start.toLowerCase() : fold(start);
  const tr = TR_ORDINAL.exec(f);
  if (tr) return { length: tr[0].length, kind: tr[4] };
  const n = TR_NUMBERED.exec(f);
  if (n) return { length: n[0].length, kind: n[2] };
  const h = HEADING_RE.exec(f);
  return h ? { length: h[0].length, kind: h[1] } : null;
}

/**
 * A chapter heading: "Prologue", "Chapter 12", "Part II: The Return",
 * "Глава первая", "Birinci Bölüm", "6. BÖLÜM", "ÖNSÖZ". Not a sentence that
 * happens to start with such a word ("Part of me wanted to stay.").
 */
export function isHeadingLine(t: string): boolean {
  // (Most lines are rejected at once: too long, or starting in lower case.)
  const c = t.charCodeAt(0);
  if (t.length > 80 || (c >= 97 && c <= 122)) return false;
  if (ROMAN_RE.test(t)) return true;
  // The end of something in brackets ("Chapter I.]" closing a caption).
  if (/[\])]$/.test(t) && !/[[(]/.test(t)) return false;
  const m = headingStart(t);
  if (!m) return false;
  const rest = t.slice(m.length);
  if (/^[\s.:—–…-]*$/.test(rest)) return true;
  if (NUMBERED_RE.test(rest)) return true;
  // A word naming which one, then its title: "BOOK FOURTH—SUCCOR FROM BELOW…", "Chapter One: The Start".
  if (ORDINAL_TITLE.test(rest)) return true;
  return t.split(/\s+/).length <= 5 && !/[.!?,;:]$/.test(t);
}

/** What a heading line is a heading of, folded ('chapter', 'part', 'bolum'...; 'roman' for "XII"). */
function headingKind(t: string): string {
  if (ROMAN_RE.test(t)) return 'roman';
  return headingStart(t)?.kind ?? '';
}

/**
 * A heading line wrapped onto a second: "CHAPTER 56. Of the Less Erroneous
 * Pictures of Whales, and the True" + "Pictures of Whaling Scenes." Its
 * number or keyword is soon followed by punctuation, with no lower-case word
 * before it (not "Part 2 of the agreement says…").
 */
function wrapsAsHeading(first: string, second: string): boolean {
  const t = first + ' ' + second;
  if (t.length > 160) return false;
  const m = headingStart(t);
  if (!m) return false;
  const rest = t.slice(m.length);
  const p = rest.search(/[.:—–-]/);
  return p >= 0 && p <= 12 && !/\b[a-zçğıöşü]{3,}/.test(rest.slice(0, p));
}

/** How paragraphs are laid out in a file. */
export interface TxtLayout {
  /** The width lines are hard-wrapped at; 0 if they aren't (a line is a paragraph, or verse). */
  wrap: number;
  /** Blank lines separate the paragraphs. */
  blank: boolean;
  /** A paragraph starts with an indented line. */
  indent: boolean;
  /** Lines grouped between blank lines are verse: their breaks stay. */
  verse: boolean;
}

// Per-line helpers avoid regexes: Hermes has no JIT and a book has millions of lines.
const isSpace = (c: number) => c === 32 || c === 9 || c === 0xa0 || c === 0x3000 || (c >= 10 && c <= 13);
const firstWord = (t: string) => {
  let i = 0;
  while (i < t.length && !isSpace(t.charCodeAt(i))) i++;
  return i;
};
/** Ends a sentence: . ! ? … or : (before a list), maybe inside closing quotes or brackets. */
function endsSentence(t: string): boolean {
  let i = t.length - 1;
  while (i > 0 && CLOSERS.indexOf(t[i]) >= 0) i--;
  return '.!?…:'.indexOf(t[i]) >= 0;
}
const CLOSERS = '"\'”’»)]_*';
/** The line's first letter is a capital. */
const upperStart = (t: string) => {
  for (let i = 0; i < t.length && i < 4; i++) {
    const c = t[i];
    const lower = c.toLowerCase();
    if (lower !== c.toUpperCase()) return c !== lower;
  }
  return false;
};
/** A line's length as laid out in the file: its indentation counts, trailing spaces don't. */
const visualLength = (raw: string) => {
  let n = raw.length;
  while (n > 0 && isSpace(raw.charCodeAt(n - 1))) n--;
  return n;
};

/**
 * The layout of a file, from samples of its lines (each array is a run of
 * consecutive lines). Hard wrapping shows as most lines being nearly as long
 * as the longest, with the next line's first word never fitting on a line
 * (verse lines can be just as even, but the next word often would fit).
 */
export function detectLayout(samples: string[][]): TxtLayout {
  let blank = 0;
  let indented = 0;
  const lens: number[] = [];
  // Consecutive non-empty lines: the first one's length and the second one's first word.
  const pairs: { len: number; fw: number; end: boolean }[] = [];
  // Lines after the first in groups between blank lines: starting with a capital, ending a sentence.
  let follow = 0;
  let followUpper = 0;
  let groupEnds = 0;
  for (const lines of samples) {
    let prev: string | null = null;
    let prevLen = 0;
    for (const raw of lines) {
      const t = raw.trim();
      if (!t) {
        blank++;
        prev = null;
        continue;
      }
      const len = visualLength(raw);
      lens.push(len);
      if (startsIndented(raw)) indented++;
      if (prev !== null) {
        const end = endsSentence(prev);
        pairs.push({ len: prevLen, fw: firstWord(t), end });
        follow++;
        if (upperStart(t)) followUpper++;
        if (end) groupEnds++;
      }
      prev = t;
      prevLen = len;
    }
  }
  const n = lens.length;
  const layout: TxtLayout = { wrap: 0, blank: false, indent: false, verse: false };
  if (!n) return layout;
  layout.wrap = wrapWidth(lens, pairs);
  if (layout.wrap) {
    // Paragraphs ending at blank lines, or at short lines ending a sentence?
    let ends = 0;
    for (const p of pairs) if (p.end && p.len + 1 + p.fw <= layout.wrap) ends++;
    layout.blank = blank > 0 && blank >= ends;
    layout.indent = !layout.blank && indented >= n * 0.03 && indented < n * 0.9;
  } else {
    layout.blank = blank / n > 0.15;
    layout.indent = indented / n > 0.2 && indented / n < 0.9;
    // Verse: lines in a group start with capitals and run on past their ends (prose has a sentence a line, if any).
    layout.verse = layout.blank && follow >= 4 && followUpper >= follow * 0.6 && groupEnds < follow * 0.6;
  }
  return layout;
}

/**
 * The width lines are wrapped at (see detectLayout), or 0. Lines ending a
 * sentence don't count: a paragraph may end on a long line in prose too.
 */
function wrapWidth(lens: number[], pairs: { len: number; fw: number; end: boolean }[]): number {
  if (lens.length < 20 || pairs.length < 10) return 0;
  const sorted = lens.slice().sort((a, b) => a - b);
  const top = Math.min(200, sorted[Math.floor(sorted.length * 0.99)]);
  const low = Math.max(40, sorted[Math.floor(sorted.length * 0.5)]);
  // The widest width at which the text reads as wrapped: wider sections (a
  // licence wrapped at 76 before a book wrapped at 70) mustn't set it.
  for (let w = top; w >= low; w--) {
    let full = 0;
    let fits = 0;
    for (const p of pairs) {
      if (p.end || p.len > w || p.len < w * 0.75) continue;
      full++;
      if (p.len + 1 + p.fw <= w) fits++;
    }
    if (full < 10 || fits > full * 0.05) continue;
    let near = 0;
    for (const l of lens) if (l <= w && l >= w * 0.75) near++;
    if (near >= lens.length * 0.4) return w;
  }
  return 0;
}

/** Windows of the file to sample past its start, spread evenly (all of the rest, if that's less). */
function sampleWindows(src: ByteSource, from: number, count: number, size: number): Uint8Array[] {
  const rest = src.size - from;
  if (rest <= 0) return [];
  if (rest <= count * size) return [src.read(from, rest)];
  const out: Uint8Array[] = [];
  const room = rest - size;
  for (let i = 1; i <= count; i++) {
    // Even offsets keep UTF-16 text aligned.
    const at = (from + Math.floor((room * i) / count)) & ~1;
    out.push(src.read(at, size));
  }
  return out;
}

/** The whole lines of a sample cut from the file (`mid`: from the middle, so its first line is partial too). */
function linesOf(bytes: Uint8Array, enc: Encoding, mid: boolean): string[] {
  const lines = createDecoder(enc).decode(bytes).split(/\r\n|\n|\r/);
  lines.pop();
  if (mid) lines.shift();
  return lines;
}

const HEAD = 64 * 1024;
const WINDOWS = 8;
const WINDOW = 16 * 1024;

/** How a line joins the one before it: the rest of a wrapped line, a line break kept, or a new paragraph. */
type Break = 'wrap' | 'line' | 'para';

/** Lines of one block, each joined to the one before as `how` says; a kept break only where `keepBreaks`. */
function writeLines(w: BookWriter, lines: string[], how: Break[], keepBreaks: boolean) {
  lines.forEach((t, i) => {
    if (i && how[i - 1] === 'line' && keepBreaks) w.lineBreak();
    else if (i) w.text(' ');
    w.text(t);
  });
}

/** A heading as folded words ("chapter i"), and whether two are the same one (one may go on longer). */
const keyOf = (lines: string[]) => fold(lines.join(' ')).replace(/[^a-z0-9\u00c0-\u1fff]+/g, ' ').trim();
const sameHeading = (a: string, b: string) => !!a && !!b && (a === b || a.startsWith(b + ' ') || b.startsWith(a + ' '));

/**
 * Headings not written yet. A run of them with no text between is a list
 * of contents when one kind comes twice ("Chapter I.", "Chapter II.") or
 * there are many: not chapters each starting a new page (the last of them
 * is a chapter's start if it repeats one listed). "PART I", "Book I",
 * "Chapter I." in a row are headings.
 */
class HeadingQueue {
  private queue: { lines: string[]; how: Break[]; kind: string }[] = [];
  private run = 0;
  /** The kinds of heading in the run ('chapter', 'part'…), and whether one came twice. */
  private runKinds = new Set<string>();
  private repeated = false;
  /**
   * The first heading of each kind written so far, as folded words ("chapter
   * i"): a list of contents ending in "BOOK ONE", "CHAPTER I" again ends with
   * the text's own headings.
   */
  private firstOfKind = new Map<string, string>();

  constructor(
    private w: BookWriter,
    private keepBreaks: boolean,
  ) {}

  /** A heading of one line, or two (`how` joins them). */
  add(lines: string[], how: Break[]) {
    const kind = headingKind(lines[0]);
    this.queue.push({ lines, how, kind });
    this.run++;
    if (this.runKinds.has(kind)) this.repeated = true;
    this.runKinds.add(kind);
    if (this.queue.length >= 64) this.flush(true);
  }

  /**
   * Write the queued headings. `more`: the run goes on (the queue is long);
   * its last few stay queued, as the text's own headings may be among them.
   */
  flush(more: boolean) {
    const { w, queue } = this;
    const list = this.run >= 3 && (this.repeated || this.run >= 6);
    // At the end of a list of contents, the headings that repeat the first
    // listed of their kind ("BOOK ONE", "CHAPTER I" again) start the text.
    let starts = queue.length;
    if (list && !more) {
      const firsts = new Map(this.firstOfKind);
      const keys = queue.map((q) => keyOf(q.lines));
      // The first of its kind (written before, or else the first in the list) is the list's own, not a repeat.
      const own = queue.map((q, i) => {
        if (firsts.has(q.kind)) return false;
        firsts.set(q.kind, keys[i]);
        return true;
      });
      while (starts > 0 && !own[starts - 1] && sameHeading(firsts.get(queue[starts - 1].kind)!, keys[starts - 1])) starts--;
    }
    const keep = more ? 8 : 0;
    for (let i = 0; queue.length > keep; i++) {
      const { lines, how, kind } = queue.shift()!;
      if (!this.firstOfKind.has(kind)) this.firstOfKind.set(kind, keyOf(lines));
      // (A list's own title, "Contents", is a heading.)
      if (list && i < starts && kind !== 'contents' && kind !== 'icindekiler') {
        writeLines(w, lines, how, this.keepBreaks);
        w.endBlock();
        continue;
      }
      w.chapterBreak();
      w.setKind('h', 2);
      // Two heading lines keep their break; one wrapped onto the next runs on.
      lines.forEach((t, k) => {
        if (k && how[k - 1] === 'line') w.lineBreak();
        else if (k) w.text(' ');
        w.text(t);
      });
      w.endBlock();
      w.setKind('p');
    }
    if (!more && this.run) {
      this.run = 0;
      this.runKinds = new Set();
      this.repeated = false;
    }
  }
}

/**
 * A TXT file's text as blocks, from its lines one at a time: which lines make
 * a paragraph, which are headings, scene breaks or verse, as `layout` says.
 */
class TxtParagraphs {
  /** The book's first words: its title when the file came without a name. */
  opening: string | null = null;
  /** A very long line is being written in fragments, and some has been. */
  inLine = false;

  /** Inside a paragraph, a line break kept on purpose shows in wrapped text and verse; otherwise lines run on. */
  private keepBreaks: boolean;
  private headings: HeadingQueue;
  // The paragraph being built. Its first lines are held back while they could
  // still be a heading (one or two heading lines) or a scene break; after
  // that it streams.
  private held: string[] = [];
  /** How each held line after the first joins the one before it. */
  private joins: Break[] = [];
  private streaming = false;
  /** The last line of the open paragraph (null: none open), and its length in the file. */
  private last: string | null = null;
  private lastLen = 0;
  /** A blank line after verse: a gap between stanzas. */
  private gap = false;

  constructor(
    private w: BookWriter,
    private layout: TxtLayout,
  ) {
    this.keepBreaks = !!layout.wrap || layout.verse;
    this.headings = new HeadingQueue(w, this.keepBreaks);
  }

  /** A whole line, or the end of a very long one whose start came as fragments. */
  line(rest: string) {
    if (this.inLine) {
      this.w.text(rest);
      this.inLine = false;
      // Too long to be anything but a paragraph of its own.
      this.endPara();
    } else {
      this.addLine(rest);
    }
  }

  /** A piece of a very long line, cut at a space. */
  fragment(frag: string) {
    this.opening ??= frag.trim() || null;
    if (!this.inLine) {
      if (this.last !== null && this.breakBefore(frag.trim(), frag, false) === 'para') this.endPara();
      if (!this.streaming) this.releaseHeld();
      // (A space only between this and text before it in the paragraph.)
      this.w.text(' ');
      this.last = '';
      this.inLine = true;
    }
    this.w.text(frag);
  }

  /** The end of the file. */
  finish() {
    this.endPara();
    this.headings.flush(false);
  }

  /** The held lines turn out to be text. */
  private releaseHeld() {
    this.beginText();
    writeLines(this.w, this.held, this.joins, this.keepBreaks);
    this.held = [];
    this.joins = [];
    this.streaming = true;
  }

  /** Before a paragraph's first text: what comes before it, and its kind. */
  private beginText() {
    this.headings.flush(false);
    if (this.gap) {
      this.w.emptyLine();
      this.gap = false;
    }
    if (this.layout.verse) this.w.setKind('v');
  }

  private endPara() {
    const { w } = this;
    if (!this.streaming && this.held.length) {
      if (this.held.length === 1 && SCENE_BREAK_RE.test(this.held[0])) {
        this.headings.flush(false);
        w.separator();
      } else {
        this.headings.add(this.held, this.joins);
        this.gap = false;
      }
    }
    if (this.held.length) this.held = [];
    if (this.joins.length) this.joins = [];
    w.endBlock();
    w.setKind('p');
    this.streaming = false;
    this.last = null;
  }

  private breakBefore(t: string, raw: string, heading: boolean): Break {
    const { layout } = this;
    if (layout.indent && startsIndented(raw)) return 'para';
    if (layout.wrap) {
      // A line the next word would have fitted on was broken on purpose;
      // a heading line after it, or after the end of a sentence, starts afresh.
      if (this.lastLen + 1 + firstWord(t) > layout.wrap) return heading && endsSentence(this.last!) ? 'para' : 'wrap';
      if (heading) return 'para';
      return !layout.blank && endsSentence(this.last!) ? 'para' : 'line';
    }
    // (A heading starts afresh even unindented, among paragraphs that start with an indent.)
    if (layout.indent) return heading ? 'para' : 'wrap';
    return layout.blank ? 'line' : 'para';
  }

  private addLine(raw: string) {
    const { w, layout } = this;
    const t = raw.trim();
    if (!t) {
      if (this.last !== null) {
        const verse = this.streaming && layout.verse;
        this.endPara();
        if (verse) this.gap = true;
      }
      return;
    }
    this.opening ??= t;
    const heading = isHeadingLine(t);
    let how: Break | null = this.last === null ? null : this.breakBefore(t, raw, heading);
    if (how && how !== 'para' && !this.streaming) {
      // Held back so far: a heading line or two (or one wrapped onto a second line), or a scene break.
      const { held, joins } = this;
      const scene = held.length === 1 && SCENE_BREAK_RE.test(held[0]);
      // (`: boolean`: as an inferred type guard it would narrow `joins` to 'line' below, where 'wrap' is pushed.)
      const headings = !scene && joins.every((j): boolean => j === 'line') && held.every(isHeadingLine);
      if (how === 'line' && headings && held.length < 2 && heading) {
        held.push(t);
        joins.push(how);
      } else if (how === 'wrap' && layout.wrap && headings && held.length === 1 && wrapsAsHeading(held[0], t)) {
        held.push(t);
        joins.push(how);
      } else if (
        scene ||
        // A heading followed straight by text (or, in text that isn't wrapped, by a line running on) stands on its own.
        (headings && (how === 'wrap' ? !layout.wrap : !heading)) ||
        (!headings && how === 'line' && !heading)
      ) {
        how = 'para';
      } else this.releaseHeld(); // not a heading after all (a list of them, or a paragraph starting like one)
    }
    if (how === 'para' || how === null) {
      if (how) this.endPara();
      if (heading || SCENE_BREAK_RE.test(t)) {
        this.held = [t];
        this.joins = [];
      } else {
        this.beginText();
        w.text(t);
        this.streaming = true;
      }
    } else if (this.streaming) {
      if (how === 'line' && this.keepBreaks) w.lineBreak();
      else w.text(' ');
      w.text(t);
    }
    this.last = t;
    this.lastLen = visualLength(raw);
  }
}

export async function ingestTxt(ctx: IngestContext): Promise<Manifest> {
  const { src } = ctx;
  const head = src.read(0, Math.min(src.size, HEAD));
  const bom = detectBom(head);
  // Samples from further in too: a file can open with pages of plain ASCII
  // (a licence, a preface) or with a layout of its own.
  const windows = sampleWindows(src, head.length, WINDOWS, WINDOW);
  const enc = sniffEncoding(head, windows);
  await ctx.pause();
  const layout = detectLayout([linesOf(head.subarray(bom?.skip ?? 0), enc, false), ...windows.map((w) => linesOf(w, enc, true))]);
  await ctx.pause();

  // Text from a one-byte encoding has no combining marks to compose.
  const w = new BookWriter(ctx.sink, enc !== 'utf-8' && enc !== 'utf-16le' && enc !== 'utf-16be');
  const paras = new TxtParagraphs(w, layout);
  const decoder = createDecoder(enc);
  let carry = '';
  let skipLF = false;
  for (let pos = bom?.skip ?? 0; pos < src.size; ) {
    const n = Math.min(READ_SLICE, src.size - pos);
    let text = carry + decoder.decode(src.read(pos, n));
    pos += n;
    if (skipLF && text.startsWith('\n')) text = text.slice(1);
    // A trailing '\r' may be the first half of a '\r\n' split across slices.
    skipLF = text.endsWith('\r');
    const lines = text.split(/\r\n|\n|\r/);
    carry = lines.pop() ?? '';
    for (const line of lines) paras.line(line);
    if (carry.length > LONG_LINE) {
      // Very long lines are written in fragments, cut at a space so words stay whole.
      let cut = carry.lastIndexOf(' ');
      if (cut < carry.length / 2) cut = carry.length;
      paras.fragment(carry.slice(0, cut));
      carry = carry.slice(cut);
    }
    ctx.progress(pos / src.size);
    await ctx.pause();
  }
  carry += decoder.end();
  if (carry || paras.inLine) paras.line(carry);
  paras.finish();
  w.finish();
  await ctx.pause();

  return {
    v: ENGINE_VERSION,
    format: 'txt',
    title: ctx.fallbackTitle === UNTITLED && paras.opening ? shortTitle(cleanText(paras.opening)) : ctx.fallbackTitle,
    author: '',
    lang: guessLanguage(w.textSample()),
    totalBlocks: w.totalBlocks,
    totalChars: w.totalChars,
    chunks: w.chunks,
    weights: w.weights,
    opens: w.opens,
    toc: w.headings,
    images: {},
  };
}

/** A line of text as a title: at most about 60 characters, cut between words. */
export function shortTitle(line: string): string {
  if (line.length <= 60) return line;
  const cut = line.lastIndexOf(' ', 60);
  return (cut > 20 ? line.slice(0, cut) : line.slice(0, 60)).replace(/[\s,;:–—-]+$/, '') + '…';
}
