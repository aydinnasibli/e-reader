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
  // Matched folded: capitals, accents and the Turkish dotted and dotless i make no difference.
  // (Folding keeps the length, so offsets in it are offsets in the line; the
  // longest heading word or ordinal fits in the first 32 characters.)
  const start = t.slice(0, 32);
  const f = ASCII.test(start) ? start.toLowerCase() : fold(start);
  const m = TR_ORDINAL.exec(f) ?? TR_NUMBERED.exec(f) ?? HEADING_RE.exec(f);
  if (!m) return false;
  const rest = t.slice(m[0].length);
  if (/^[\s.:—–…-]*$/.test(rest)) return true;
  if (NUMBERED_RE.test(rest)) return true;
  // A word naming which one, then its title: "BOOK FOURTH—SUCCOR FROM BELOW…", "Chapter One: The Start".
  if (ORDINAL_TITLE.test(rest)) return true;
  return t.split(/\s+/).length <= 5 && !/[.!?,;:]$/.test(t);
}

/** What a heading line is a heading of, folded ('chapter', 'part', 'bolum'...; 'roman' for "XII"). */
function headingKind(t: string): string {
  if (ROMAN_RE.test(t)) return 'roman';
  const start = t.slice(0, 32);
  const f = ASCII.test(start) ? start.toLowerCase() : fold(start);
  const tr = TR_ORDINAL.exec(f);
  if (tr) return tr[4];
  return TR_NUMBERED.exec(f)?.[2] ?? HEADING_RE.exec(f)?.[1] ?? '';
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
  const start = t.slice(0, 32);
  const f = ASCII.test(start) ? start.toLowerCase() : fold(start);
  const m = TR_ORDINAL.exec(f) ?? TR_NUMBERED.exec(f) ?? HEADING_RE.exec(f);
  if (!m) return false;
  const rest = t.slice(m[0].length);
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
  // Inside a paragraph, a line break kept on purpose shows in wrapped text and verse; otherwise lines run on.
  const keepBreaks = !!layout.wrap || layout.verse;

  // Text from a one-byte encoding has no combining marks to compose.
  const w = new BookWriter(ctx.sink, enc !== 'utf-8' && enc !== 'utf-16le' && enc !== 'utf-16be');
  // The paragraph being built. Its first lines are held back while they could
  // still be a heading (one or two heading lines) or a scene break; after
  // that it streams.
  let held: string[] = [];
  /** How each held line after the first joins the one before it. */
  let joins: Break[] = [];
  let streaming = false;
  /** The last line of the open paragraph (null: none open), and its length in the file. */
  let last: string | null = null;
  let lastLen = 0;
  // Headings not written yet. A run of them with no text between is a list
  // of contents when one kind comes twice ("Chapter I.", "Chapter II.") or
  // there are many: not chapters each starting a new page (the last of them
  // is a chapter's start if it repeats one listed). "PART I", "Book I",
  // "Chapter I." in a row are headings.
  let queue: { lines: string[]; how: Break[]; kind: string }[] = [];
  let run = 0;
  /** The kinds of heading in the run ('chapter', 'part'…), and whether one came twice. */
  let runKinds = new Set<string>();
  let repeated = false;
  /**
   * The first heading of each kind written so far, as folded words ("chapter
   * i"): a list of contents ending in "BOOK ONE", "CHAPTER I" again ends with
   * the text's own headings.
   */
  const firstOfKind = new Map<string, string>();
  const keyOf = (lines: string[]) => fold(lines.join(' ')).replace(/[^a-z0-9\u00c0-\u1fff]+/g, ' ').trim();
  const sameHeading = (a: string, b: string) => !!a && !!b && (a === b || a.startsWith(b + ' ') || b.startsWith(a + ' '));
  // A blank line after verse: a gap between stanzas.
  let gap = false;
  // The book's first words: its title when the file came without a name.
  let opening: string | null = null;

  const writeLines = (lines: string[], how: Break[]) =>
    lines.forEach((t, i) => {
      if (i && how[i - 1] === 'line' && keepBreaks) w.lineBreak();
      else if (i) w.text(' ');
      w.text(t);
    });

  /**
   * Write the queued headings. `more`: the run goes on (the queue is long);
   * its last few stay queued, as the text's own headings may be among them.
   */
  const flushQueue = (more: boolean) => {
    const list = run >= 3 && (repeated || run >= 6);
    // At the end of a list of contents, the headings that repeat the first
    // listed of their kind ("BOOK ONE", "CHAPTER I" again) start the text.
    let starts = queue.length;
    if (list && !more) {
      const firsts = new Map(firstOfKind);
      const keys = queue.map((q) => keyOf(q.lines));
      const own = queue.map((q, i) => !firsts.has(q.kind) && !!firsts.set(q.kind, keys[i]));
      while (starts > 0 && !own[starts - 1] && sameHeading(firsts.get(queue[starts - 1].kind)!, keys[starts - 1])) starts--;
    }
    const keep = more ? 8 : 0;
    for (let i = 0; queue.length > keep; i++) {
      const { lines, how, kind } = queue.shift()!;
      if (!firstOfKind.has(kind)) firstOfKind.set(kind, keyOf(lines));
      // (A list's own title, "Contents", is a heading.)
      if (list && i < starts && kind !== 'contents' && kind !== 'icindekiler') {
        writeLines(lines, how);
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
    if (!more && run) {
      run = 0;
      runKinds = new Set();
      repeated = false;
    }
  };

  /** The held lines turn out to be text. */
  const releaseHeld = () => {
    beginText();
    writeLines(held, joins);
    held = [];
    joins = [];
    streaming = true;
  };

  /** Before a paragraph's first text: what comes before it, and its kind. */
  const beginText = () => {
    flushQueue(false);
    if (gap) {
      w.emptyLine();
      gap = false;
    }
    if (layout.verse) w.setKind('v');
  };

  const endPara = () => {
    if (!streaming && held.length) {
      if (held.length === 1 && SCENE_BREAK_RE.test(held[0])) {
        flushQueue(false);
        w.separator();
      } else {
        const kind = headingKind(held[0]);
        queue.push({ lines: held, how: joins, kind });
        run++;
        if (runKinds.has(kind)) repeated = true;
        runKinds.add(kind);
        gap = false;
        if (queue.length >= 64) flushQueue(true);
      }
    }
    if (held.length) held = [];
    if (joins.length) joins = [];
    w.endBlock();
    w.setKind('p');
    streaming = false;
    last = null;
  };

  const breakBefore = (t: string, raw: string, heading: boolean): Break => {
    if (layout.indent && startsIndented(raw)) return 'para';
    if (layout.wrap) {
      // A line the next word would have fitted on was broken on purpose;
      // a heading line after it, or after the end of a sentence, starts afresh.
      if (lastLen + 1 + firstWord(t) > layout.wrap) return heading && endsSentence(last!) ? 'para' : 'wrap';
      if (heading) return 'para';
      return !layout.blank && endsSentence(last!) ? 'para' : 'line';
    }
    // (A heading starts afresh even unindented, among paragraphs that start with an indent.)
    if (layout.indent) return heading ? 'para' : 'wrap';
    return layout.blank ? 'line' : 'para';
  };

  const addLine = (raw: string) => {
    const t = raw.trim();
    if (!t) {
      if (last !== null) {
        const verse = streaming && layout.verse;
        endPara();
        if (verse) gap = true;
      }
      return;
    }
    opening ??= t;
    const heading = isHeadingLine(t);
    let how: Break | null = last === null ? null : breakBefore(t, raw, heading);
    if (how && how !== 'para' && !streaming) {
      // Held back so far: a heading line or two (or one wrapped onto a second line), or a scene break.
      const scene = held.length === 1 && SCENE_BREAK_RE.test(held[0]);
      const headings = !scene && joins.every((j) => j === 'line') && held.every(isHeadingLine);
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
      } else releaseHeld(); // not a heading after all (a list of them, or a paragraph starting like one)
    }
    if (how === 'para' || how === null) {
      if (how) endPara();
      if (heading || SCENE_BREAK_RE.test(t)) {
        held = [t];
        joins = [];
      } else {
        beginText();
        w.text(t);
        streaming = true;
      }
    } else if (streaming) {
      if (how === 'line' && keepBreaks) w.lineBreak();
      else w.text(' ');
      w.text(t);
    }
    last = t;
    lastLen = visualLength(raw);
  };

  // Very long lines arrive in fragments. `inLine` means a fragment of the
  // current line has already been written.
  let inLine = false;
  const addFragment = (frag: string) => {
    opening ??= frag.trim() || null;
    if (!inLine) {
      if (last !== null && breakBefore(frag.trim(), frag, false) === 'para') endPara();
      if (!streaming) releaseHeld();
      // (A space only between this and text before it in the paragraph.)
      w.text(' ');
      last = '';
      inLine = true;
    }
    w.text(frag);
  };
  const endLine = (rest: string) => {
    if (inLine) {
      w.text(rest);
      inLine = false;
      // Too long to be anything but a paragraph of its own.
      endPara();
    } else {
      addLine(rest);
    }
  };

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
    for (const line of lines) endLine(line);
    if (carry.length > LONG_LINE) {
      // Cut at a space so words stay whole.
      let cut = carry.lastIndexOf(' ');
      if (cut < carry.length / 2) cut = carry.length;
      addFragment(carry.slice(0, cut));
      carry = carry.slice(cut);
    }
    ctx.progress(pos / src.size);
    await ctx.pause();
  }
  carry += decoder.end();
  if (carry || inLine) endLine(carry);
  endPara();
  flushQueue(false);
  w.finish();
  await ctx.pause();

  return {
    v: ENGINE_VERSION,
    format: 'txt',
    title: ctx.fallbackTitle === UNTITLED && opening ? shortTitle(cleanText(opening)) : ctx.fallbackTitle,
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
