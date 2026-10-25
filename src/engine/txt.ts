// Plain text: detect the encoding and how paragraphs are laid out, then stream
// the file line by line. Lines of any length are fine; a 100 MB file with no
// line breaks at all is fed to the writer in slices, never as one string.

import { createDecoder, detectBom, sniffEncoding } from './decode';
import { type IngestContext, READ_SLICE, UNTITLED } from './io';
import { ENGINE_VERSION, type Manifest } from './types';
import { BookWriter } from './writer';

/** How paragraphs are separated in this file. */
type ParaMode = 'line' | 'blank' | 'indent';

const HEADING_RE =
  /^(chapter|part|book|prologue|epilogue|introduction|preface|contents|глава|часть|книга|пролог|эпилог|предисловие|послесловие|введение|fəsil|hissə|bölüm|kısım|kapitel|teil|chapitre|partie|capítulo|parte|capitolo|rozdział|розділ|частина)(?=$|[\s.:,!?\d-])/i;
const ROMAN_RE = /^[IVXLCDM]{1,8}\.?$/;
const SCENE_BREAK_RE = /^(\*\s*){3,}$|^(-\s*){3,}$|^#$/;
const LONG_LINE = 64 * 1024;

function startsIndented(s: string) {
  const c = s.charCodeAt(0);
  return c === 32 || c === 9 || c === 0x3000;
}

export function detectParaMode(sample: string): ParaMode {
  const lines = sample.split(/\r\n|\r|\n/).slice(0, -1);
  let blank = 0;
  let indented = 0;
  let nonEmpty = 0;
  for (const l of lines) {
    if (!l.trim()) blank++;
    else {
      nonEmpty++;
      if (startsIndented(l)) indented++;
    }
  }
  if (nonEmpty === 0) return 'line';
  if (blank / nonEmpty > 0.15) return 'blank';
  if (indented / nonEmpty > 0.2 && indented / nonEmpty < 0.9) return 'indent';
  return 'line';
}

const NUMBERED_RE = /^[\s.:—–-]*(\d+|[IVXLCDM]+)(?=$|[\s.:,—–-])/i;

/**
 * A chapter heading: "Prologue", "Chapter 12", "Part II: The Return",
 * "Глава первая". Not a sentence that happens to start with such a word
 * ("Part of me wanted to stay.").
 */
export function isHeadingLine(t: string): boolean {
  if (t.length > 80) return false;
  if (ROMAN_RE.test(t)) return true;
  const m = HEADING_RE.exec(t);
  if (!m) return false;
  const rest = t.slice(m[0].length);
  if (/^[\s.:—–-]*$/.test(rest)) return true;
  if (NUMBERED_RE.test(rest)) return true;
  return t.split(/\s+/).length <= 5 && !/[.!?,;:]$/.test(t);
}

export async function ingestTxt(ctx: IngestContext): Promise<Manifest> {
  const { src } = ctx;
  const head = src.read(0, Math.min(src.size, 64 * 1024));
  const bom = detectBom(head);
  const enc = sniffEncoding(head);
  const sampleDecoder = createDecoder(enc);
  const mode = detectParaMode(sampleDecoder.decode(head.subarray(bom?.skip ?? 0)));

  const w = new BookWriter(ctx.sink);
  // Paragraph state. The first line is held back until we know whether it's a heading.
  let firstLine: string | null = null;
  let lineCount = 0;
  // The book's first words: its title when the file came without a name.
  let opening: string | null = null;

  const flushPara = () => {
    if (lineCount === 1 && firstLine !== null && isHeadingLine(firstLine)) {
      w.chapterBreak();
      w.setKind('h', 2);
      w.text(firstLine);
      w.endBlock();
      w.setKind('p');
    } else if (lineCount === 1 && firstLine !== null && SCENE_BREAK_RE.test(firstLine)) {
      w.separator();
    } else if (firstLine !== null) {
      w.text(firstLine);
    }
    w.endBlock();
    firstLine = null;
    lineCount = 0;
  };

  const addLine = (raw: string) => {
    const t = raw.trim();
    if (!t) {
      flushPara();
      return;
    }
    opening ??= t;
    if (mode === 'line' || (mode === 'indent' && startsIndented(raw))) flushPara();
    if (lineCount === 0) firstLine = t;
    else {
      if (firstLine !== null) {
        w.text(firstLine);
        firstLine = null;
      }
      w.text('\n' + t);
    }
    lineCount++;
    if (mode === 'line') flushPara();
  };

  const releaseFirst = () => {
    if (firstLine !== null) {
      w.text(firstLine);
      firstLine = null;
    }
  };

  // Very long lines arrive in fragments. `inLine` means a fragment of the
  // current line has already been written.
  let inLine = false;
  const addFragment = (frag: string) => {
    opening ??= frag.trim() || null;
    if (!inLine) {
      if (mode === 'line' || (mode === 'indent' && startsIndented(frag))) flushPara();
      releaseFirst();
      if (lineCount > 0) w.text('\n');
      lineCount = 2; // too long to be a heading
      inLine = true;
    }
    w.text(frag);
  };
  const endLine = (rest: string) => {
    if (inLine) {
      w.text(rest);
      inLine = false;
      if (mode === 'line') flushPara();
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
  flushPara();
  w.finish();

  return {
    v: ENGINE_VERSION,
    format: 'txt',
    title: ctx.fallbackTitle === UNTITLED && opening ? shortTitle(opening) : ctx.fallbackTitle,
    author: '',
    totalBlocks: w.totalBlocks,
    totalChars: w.totalChars,
    chunks: w.chunks,
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
