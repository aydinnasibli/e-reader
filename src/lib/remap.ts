// Moving highlights, bookmarks and the reading place onto another conversion
// of the same book. Marks are saved as block numbers, which change when a
// book is converted differently (a newer converter, "Try again", a backup
// made from another conversion), so each mark is found again by its text,
// with a little of the text around it when that is known: first near where
// it was (the same share of the book), then anywhere in the book, then
// ignoring case, accents and punctuation. One whose text can't be found stays
// at the best estimate: a mark is never dropped. Pure, so it is tested
// without the app.

import { fold } from '@/engine/fold';
import { type Block, type Position, type TocEntry, blockLength, blockText } from '@/engine/types';
import type { Bookmark, Highlight } from './annotations';

/** Read access to a converted book: its chunk table and its chunks. */
export interface Conversion {
  /** Per chunk: [first block, characters before it]. */
  chunks: [number, number][];
  totalBlocks: number;
  totalChars: number;
  read(chunk: number): Promise<Block[]>;
}

/** Where a mark was, to find it again. */
export interface Anchor {
  /** Characters before it in the conversion it was made on, as a share of that book (0..1). */
  at?: number;
  /** Otherwise (that conversion couldn't be read) its block and offset there. */
  b?: number;
  o?: number;
  /** Text at the mark: a highlight's own text, or the text from a place onwards. */
  text: string;
  /** Text just before and after it in its paragraph, to tell apart the same words in other places. */
  before?: string;
  after?: string;
}

/** What a highlight needs to be moved. */
export interface Ranged {
  id: string;
  b: number;
  s: number;
  e: number;
  text: string;
  note?: string;
}

/** Characters taken from a place onwards to find it again. */
export const SAMPLE = 80;
/** Characters of the text around a mark kept with it (on each side). */
const CONTEXT = 48;
/** Of those, how many are tried when all of it isn't found (the new conversion changed something nearby). */
const NEAR_CONTEXT = 16;

/** Books with more chunks than this are searched near each mark only, not through and through. */
const WHOLE_BOOK_CHUNKS = 600;
/** Chunks on either side of the estimate searched first. */
const NEAR = 2;
/**
 * Chunks read together when going through the whole book. Each is put
 * together a chunk at a time with a pause between, so the screen keeps
 * drawing while a book's marks are found.
 */
const SPAN = 4;

// ---------- text as compared ----------

const isSpace = (c: number) =>
  c <= 32 || c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
/** Soft hyphens and invisible breaks: not part of the text as read. */
const isDropped = (c: number) => c === 0xad || c === 0x200b || c === 0x2060;
const MARK = /\p{M}/u;
const WORD = /[\p{L}\p{N}]/u;

/** Normalised text of some blocks, and where each of its characters came from. */
interface Text {
  s: string;
  /** Per character of `s`: its block, and the [from, to) range of the block's text it stands for. */
  blk: number[];
  from: number[];
  to: number[];
}

/**
 * The text compared when finding a mark: composed (NFC), without soft
 * hyphens, every run of white space (and each break between blocks) one
 * space, no space at either end. `loose` also folds case, accents and the
 * Turkish i (fold.ts), and keeps only letters and digits. Blocks are added
 * one after another (a window of a book is put together a chunk at a time).
 */
class Normaliser {
  private out: string[] = [];
  private blk: number[] = [];
  private from: number[] = [];
  private to: number[] = [];
  private space = true;

  constructor(private loose: boolean) {}

  private gap(b: number, f: number, t: number) {
    if (this.loose) return;
    if (!this.space) {
      this.out.push(' ');
      this.blk.push(b);
      this.from.push(f);
      this.to.push(t);
      this.space = true;
    } else if (this.out.length && this.blk[this.blk.length - 1] === b) this.to[this.to.length - 1] = t;
  }

  add(b: number, text: string) {
    const { loose, out, blk, from, to } = this;
    this.gap(b, 0, 0);
    for (let i = 0; i < text.length; ) {
      const c = text.charCodeAt(i);
      if (isDropped(c)) {
        i++;
        continue;
      }
      if (isSpace(c)) {
        let j = i + 1;
        while (j < text.length && (isSpace(text.charCodeAt(j)) || isDropped(text.charCodeAt(j)))) j++;
        this.gap(b, i, j);
        i = j;
        continue;
      }
      // A character with the combining marks after it, composed.
      let j = i + 1;
      if (c >= 0xd800 && c <= 0xdbff && j < text.length) j++;
      while (j < text.length && text.charCodeAt(j) >= 0x300 && MARK.test(text[j])) j++;
      let piece = text.slice(i, j);
      if (loose && c >= 0x80) piece = piece.normalize('NFKC');
      else if (j - i > 1 || c >= 0x300) piece = piece.normalize('NFC');
      for (let k = 0; k < piece.length; k++) {
        let ch = piece[k];
        if (loose) {
          ch = fold(ch);
          if (!WORD.test(ch)) continue;
        }
        out.push(ch);
        blk.push(b);
        from.push(i);
        to.push(j);
        this.space = false;
      }
      i = j;
    }
  }

  done(): Text {
    const { out, blk, from, to } = this;
    if (out.length && out[out.length - 1] === ' ') {
      out.pop();
      blk.pop();
      from.pop();
      to.pop();
    }
    return { s: out.join(''), blk, from, to };
  }
}

function normalise(blocks: { b: number; text: string }[], loose: boolean): Text {
  const n = new Normaliser(loose);
  for (const { b, text } of blocks) n.add(b, text);
  return n.done();
}

/** Text as it is compared (see normalise). */
export function comparable(text: string, loose = false): string {
  return normalise([{ b: 0, text }], loose).s;
}

/** What is searched for: the mark's text with what's around it, and where the mark itself is in it. */
interface Pattern {
  needle: string;
  /** The mark's own characters in `needle`: [k, k2). */
  k: number;
  k2: number;
}

function pattern(before: string, text: string, after: string, loose: boolean): Pattern | null {
  const n = normalise([{ b: 0, text: before + text + after }], loose);
  let k = -1;
  let k2 = -1;
  for (let i = 0; i < n.s.length; i++) {
    if (n.s[i] === ' ') continue;
    if (k < 0 && n.from[i] >= before.length) k = i;
    if (n.from[i] < before.length + text.length) k2 = i + 1;
  }
  return k >= 0 && k2 > k ? { needle: n.s, k, k2 } : null;
}

// ---------- reading a conversion ----------

/** The chunk a block is in. */
function chunkOfBlock(conv: Conversion, block: number): number {
  let lo = 0;
  let hi = conv.chunks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (conv.chunks[mid][0] <= block) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/** The chunk a character offset is in. */
function chunkOfChar(conv: Conversion, char: number): number {
  let lo = 0;
  let hi = conv.chunks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (conv.chunks[mid][1] <= char) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/** Chunks of a conversion as they're needed, a few kept. */
class Reader {
  private cache = new Map<number, Block[] | null>();
  constructor(readonly conv: Conversion) {}

  async chunk(i: number): Promise<Block[] | null> {
    if (i < 0 || i >= this.conv.chunks.length) return null;
    let blocks = this.cache.get(i);
    if (blocks === undefined) {
      try {
        blocks = await this.conv.read(i);
      } catch {
        blocks = null; // a damaged chunk: its marks fall back to estimates
      }
      this.cache.set(i, blocks);
      while (this.cache.size > SPAN + 2 * NEAR + 4) this.cache.delete(this.cache.keys().next().value!);
    }
    return blocks;
  }

  async block(b: number): Promise<Block | null> {
    const c = chunkOfBlock(this.conv, b);
    return (await this.chunk(c))?.[b - this.conv.chunks[c][0]] ?? null;
  }

  /** Characters before a block; null if its chunk can't be read. */
  async charsBefore(block: number): Promise<number | null> {
    const c = chunkOfBlock(this.conv, block);
    const blocks = await this.chunk(c);
    if (!blocks) return null;
    let n = this.conv.chunks[c][1];
    for (let k = 0; k < block - this.conv.chunks[c][0] && k < blocks.length; k++) n += blockLength(blocks[k]);
    return n;
  }

  /** The text from block `b`, offset `o`, onwards, until there's enough to find it by. */
  async sample(b: number, o: number): Promise<string> {
    let text = '';
    for (let k = b; k < this.conv.totalBlocks && comparable(text).length < SAMPLE; k++) {
      const blk = await this.block(k);
      if (!blk) break;
      const t = blockText(blk);
      const from = k === b ? o : 0;
      text += (k === b ? '' : '\n') + t.slice(from, from + 2 * SAMPLE);
      if (k - b > 50) break; // pictures and empty lines all the way: enough
    }
    return text;
  }
}

/**
 * The text of chunks [c0, c1] as compared, and where each block starts in
 * the book, put together a chunk at a time with a pause after each.
 */
async function windowOf(reader: Reader, c0: number, c1: number, loose: boolean, pause: () => Promise<void>) {
  const conv = reader.conv;
  const n = new Normaliser(loose);
  const starts = new Map<number, number>();
  for (let c = c0; c <= c1; c++) {
    const blocks = await reader.chunk(c);
    if (!blocks) continue;
    let at = conv.chunks[c][1];
    blocks.forEach((blk, k) => {
      const b = conv.chunks[c][0] + k;
      n.add(b, blockText(blk));
      starts.set(b, at);
      at += blockLength(blk);
    });
    await pause();
  }
  return { text: n.done(), starts };
}

// ---------- marks on the conversion they were made on ----------

/** A mark to anchor: `text` is a highlight's own text [o, end); places and bookmarks have none. */
export interface Mark {
  key: string;
  b: number;
  o: number;
  end?: number;
  text?: string;
  /** Text to use when the conversion can't be read (a bookmark's snippet). */
  fallback?: string;
}

/**
 * Anchors for marks on `old`, the conversion they were made on (null when it
 * is gone: then block numbers and saved texts are all there is).
 */
export async function anchorsOn(old: Conversion | null, marks: Mark[], pause: () => Promise<void> = async () => {}): Promise<Record<string, Anchor>> {
  const out: Record<string, Anchor> = {};
  const reader = old && old.chunks.length && old.totalChars > 0 ? new Reader(old) : null;
  for (const m of [...marks].sort((a, b) => a.b - b.b || a.o - b.o)) {
    let anchor: Anchor = { b: m.b, o: m.o, text: m.text ?? m.fallback ?? '' };
    const before = reader ? await reader.charsBefore(m.b) : null;
    const blk = reader && before !== null ? await reader.block(m.b) : null;
    if (reader && blk && before !== null) {
      const t = blockText(blk);
      const end = m.end ?? m.o;
      // A highlight's text as it is on that conversion (its saved text should be the same).
      const text = m.text !== undefined ? (end > m.o && t.slice(m.o, end)) || m.text : await reader.sample(m.b, m.o);
      anchor = {
        at: Math.min(1, (before + m.o) / reader.conv.totalChars),
        text: text || m.fallback || '',
        before: t.slice(Math.max(0, m.o - CONTEXT), m.o),
        ...(m.text !== undefined ? { after: t.slice(end, end + CONTEXT) } : {}),
      };
    }
    out[m.key] = anchor;
    await pause();
  }
  return out;
}

// ---------- finding marks on another conversion ----------

interface Found {
  b: number;
  o: number;
  endB: number;
  endO: number;
  start: number;
  distance: number;
}

/** A mark being looked for: its patterns, best first, and the closest match of each so far. */
interface Want {
  key: string;
  /** Characters before it on this conversion, estimated. */
  target: number;
  /** With the text around it, then on its own; `loose` the same, compared loosely. */
  exact: Pattern[];
  loose: Pattern[];
  found: (Found | undefined)[];
  foundLoose: (Found | undefined)[];
}

/** Closest matches of `pats` in a window of text, into `found`. */
function search(text: Text, starts: Map<number, number>, pats: Pattern[], found: (Found | undefined)[], target: number) {
  pats.forEach((p, n) => {
    for (let i = text.s.indexOf(p.needle); i >= 0; i = text.s.indexOf(p.needle, i + 1)) {
      const first = i + p.k;
      const last = i + p.k2 - 1;
      const start = (starts.get(text.blk[first]) ?? 0) + text.from[first];
      const distance = Math.abs(start - target);
      const best = found[n];
      if (!best || distance < best.distance) {
        found[n] = { b: text.blk[first], o: text.from[first], endB: text.blk[last], endO: text.to[last], start, distance };
      }
    }
  });
}

/** Search windows of chunks for `wants`. */
async function sweep(reader: Reader, wants: Want[], windows: [number, number][], loose: boolean, pause: () => Promise<void>) {
  if (!wants.length) return;
  for (const [c0, c1] of windows) {
    const { text, starts } = await windowOf(reader, c0, c1, loose, pause);
    for (const w of wants) search(text, starts, loose ? w.loose : w.exact, loose ? w.foundLoose : w.found, w.target);
    await pause();
  }
}

/** The block and offset at about `target` characters into the book. */
async function estimate(reader: Reader, target: number): Promise<Position> {
  const conv = reader.conv;
  if (!conv.chunks.length) return { b: 0, o: 0 };
  const c = chunkOfChar(conv, target);
  const blocks = await reader.chunk(c);
  if (!blocks?.length) return { b: Math.min(conv.chunks[c][0], Math.max(0, conv.totalBlocks - 1)), o: 0 };
  let n = conv.chunks[c][1];
  for (let k = 0; k < blocks.length; k++) {
    const len = blockLength(blocks[k]);
    if (n + len > target) return { b: conv.chunks[c][0] + k, o: Math.max(0, Math.min(blockText(blocks[k]).length, Math.floor(target - n))) };
    n += len;
  }
  return { b: conv.chunks[c][0] + blocks.length - 1, o: 0 };
}

export interface Located {
  /** Block and offset where the mark's text starts. */
  b: number;
  o: number;
  /** Where its text ends (a highlight's may end in a later block). */
  endB: number;
  endO: number;
  /** Characters before it on this conversion. */
  chars: number;
  /** False: its text wasn't found; this is the best estimate. */
  found: boolean;
}

/**
 * Find anchored marks on `conv`: near the estimate first, then (books of a
 * reasonable size) through the whole book, then the same comparing loosely,
 * else the estimate. With the text around a mark before its text alone.
 */
export async function locate(conv: Conversion, anchors: Record<string, Anchor>, pause: () => Promise<void> = async () => {}): Promise<Record<string, Located>> {
  const reader = new Reader(conv);
  const wants: Want[] = [];
  for (const [key, a] of Object.entries(anchors)) {
    let target: number;
    if (a.at !== undefined) target = a.at * conv.totalChars;
    else {
      const b = Math.min(Math.max(0, a.b ?? 0), Math.max(0, conv.totalBlocks - 1));
      target = ((await reader.charsBefore(b)) ?? 0) + (a.o ?? 0);
    }
    // With all the text around it, then a little of it, then on its own.
    const pats = (loose: boolean) => {
      const before = a.before ?? '';
      const after = a.after ?? '';
      const list = [
        before || after ? pattern(before, a.text, after, loose) : null,
        before.length > NEAR_CONTEXT || after.length > NEAR_CONTEXT ? pattern(before.slice(-NEAR_CONTEXT), a.text, after.slice(0, NEAR_CONTEXT), loose) : null,
        pattern('', a.text, '', loose),
      ];
      return list.filter((p, i): p is Pattern => !!p && p.needle.length > 0 && !list.slice(0, i).some((q) => q?.needle === p.needle));
    };
    wants.push({ key, target: Math.max(0, Math.min(conv.totalChars, target)), exact: pats(false), loose: pats(true), found: [], foundLoose: [] });
  }
  const last = conv.chunks.length - 1;
  if (last >= 0) {
    const whole: [number, number][] = [];
    for (let c = 0; c <= last; c += SPAN - 1) whole.push([c, Math.min(last, c + SPAN - 1)]);
    const at = new Map(wants.map((w) => [w, chunkOfChar(conv, w.target)]));
    // Near each estimate: the windows of the book with marks expected in or next to them, each read once.
    const near = async (ws: Want[], loose: boolean) => {
      for (const [c0, c1] of whole) await sweep(reader, ws.filter((w) => at.get(w)! >= c0 - NEAR && at.get(w)! <= c1 + NEAR), [[c0, c1]], loose, pause);
    };
    await near(wants.filter((w) => w.exact.length), false);
    const everywhere = conv.chunks.length <= WHOLE_BOOK_CHUNKS;
    // Not found with the text around it: maybe far from where it was expected.
    const unsure = wants.filter((w) => w.exact.length && !w.found[0]);
    if (everywhere && unsure.length) await sweep(reader, unsure, whole, false, pause);
    const lost = wants.filter((w) => w.loose.length && !w.found.some(Boolean));
    if (lost.length) await (everywhere ? sweep(reader, lost, whole, true, pause) : near(lost, true));
  }
  const out: Record<string, Located> = {};
  for (const w of wants) {
    const f = w.found.find(Boolean) ?? w.foundLoose.find(Boolean);
    if (f) out[w.key] = { b: f.b, o: f.o, endB: f.endB, endO: f.endO, chars: f.start, found: true };
    else {
      const p = await estimate(reader, w.target);
      out[w.key] = { b: p.b, o: p.o, endB: p.b, endO: p.o, chars: Math.round(w.target), found: false };
    }
  }
  return out;
}

/**
 * A highlight put where its text was found: one piece per block it covers on
 * the new conversion (the first keeps its id and note; the others are
 * `<id>~1`, `<id>~2`…, the same each time it is placed), or, not found,
 * about as long as it was at the estimate.
 */
export async function placeHighlight<T extends Ranged>(h: T, at: Located, conv: Conversion): Promise<T[]> {
  const reader = new Reader(conv);
  const textOf = async (b: number) => {
    const blk = await reader.block(b);
    return blk ? blockText(blk) : '';
  };
  if (!at.found || at.endB === at.b) {
    const t = await textOf(at.b);
    if (at.found) return [{ ...h, b: at.b, s: at.o, e: at.endO, text: t.slice(at.o, at.endO) }];
    const s = Math.max(0, Math.min(at.o, t.length - 1));
    const e = Math.max(s + 1, Math.min(t.length, s + Math.max(1, h.text.length)));
    return [{ ...h, b: at.b, s, e, text: t.slice(s, e) || h.text }];
  }
  const parts: T[] = [];
  for (let b = at.b; b <= at.endB; b++) {
    const t = await textOf(b);
    const piece = t.slice(b === at.b ? at.o : 0, b === at.endB ? at.endO : t.length);
    // Without the spaces at its ends, as when a highlight is cut (none if only spaces).
    const kept = piece.trim();
    if (!kept) continue;
    const s = (b === at.b ? at.o : 0) + (piece.length - piece.trimStart().length);
    const first = !parts.length;
    const part = { ...h, id: first ? h.id : `${h.id}~${parts.length}`, b, s, e: s + kept.length, text: kept };
    if (!first) delete part.note;
    parts.push(part);
  }
  return parts.length ? parts : [{ ...h, b: at.b, s: at.o, e: Math.max(at.o + 1, at.endO) }];
}

// ---------- a book's marks, moved together ----------

/** The highlights, bookmarks and place of a book, anchored to be put on another conversion of it. */
export interface MarkSet {
  /** Names the set while it waits (library.ts marks.json). */
  key?: string;
  /** A backup's marks, added to what the book has (true); or the book's own, moved (false). */
  merge: boolean;
  highlights: Highlight[];
  bookmarks: Bookmark[];
  /** By mark: `h<id>` highlights, `m<id>` bookmarks, `place`. */
  anchors: Record<string, Anchor>;
  /**
   * The reading place as it was. A backup's: `openedAt` decides whether it
   * replaces the book's own; `hadPlace` is whether the book had a place of
   * its own when the backup was restored.
   */
  place?: { position: Position; percent?: number; openedAt?: number; hadPlace?: boolean };
}

/** Marks put on the new conversion. */
export interface Moved {
  /** By the id they had: a highlight split by the new conversion's paragraphs is several. */
  highlights: Record<string, Highlight[]>;
  bookmarks: Record<string, Bookmark>;
  place?: { position: Position; percent: number };
  /** Marks whose text wasn't found, left at the best estimate. */
  unsure: number;
}

/** The marks to anchor for a book's highlights, bookmarks and place. */
export function marksOf(highlights: Highlight[], bookmarks: Bookmark[], place?: Position): Mark[] {
  return [
    ...highlights.map((h) => ({ key: `h${h.id}`, b: h.b, o: h.s, end: h.e, text: h.text })),
    ...bookmarks.map((x) => ({ key: `m${x.id}`, b: x.b, o: x.o, fallback: x.snippet })),
    ...(place ? [{ key: 'place', b: place.b, o: place.o }] : []),
  ];
}

/** Anchors from block numbers and saved texts alone (the conversion the marks were made on isn't here). */
export function savedAnchors(marks: Mark[]): Record<string, Anchor> {
  return Object.fromEntries(marks.map((m) => [m.key, { b: m.b, o: m.o, text: m.text ?? m.fallback ?? '' }]));
}

/** A book's own marks on `old`, the conversion they were made on (null: gone), to be moved. */
export async function ownMarks(old: Conversion | null, ann: { highlights: Highlight[]; bookmarks: Bookmark[] }, place: Position | undefined, percent?: number, pause?: () => Promise<void>): Promise<MarkSet> {
  return {
    merge: false,
    highlights: ann.highlights,
    bookmarks: ann.bookmarks,
    anchors: await anchorsOn(old, marksOf(ann.highlights, ann.bookmarks, place), pause),
    ...(place ? { place: { position: place, ...(percent !== undefined ? { percent } : {}) } } : {}),
  };
}

/** The title of the contents entry a block falls under. */
function chapterAt(toc: TocEntry[] | undefined, b: number): string | undefined {
  let found: string | undefined;
  for (const t of toc ?? []) {
    if (t.b <= b) found = t.t;
    else break;
  }
  return found;
}

/**
 * A bookmark's snippet: its paragraph's text from the start of the word it is
 * at, 140 characters with white space as single spaces (as the reader makes
 * one for a new bookmark).
 */
export function snippetAt(text: string, o: number): string {
  let s = Math.max(0, Math.min(o, text.length));
  while (s > 0 && !/\s/.test(text[s - 1])) s--;
  return text
    .slice(s, s + 140)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Put a set of marks on `conv`; `toc` is its contents, for the chapter each mark is in now. */
export async function moveMarks(set: MarkSet, conv: Conversion, opts: { toc?: TocEntry[]; pause?: () => Promise<void> } = {}): Promise<Moved> {
  const at = await locate(conv, set.anchors, opts.pause);
  const chapter = <T extends { chapter?: string; b: number }>(x: T): T => {
    const c = chapterAt(opts.toc, x.b);
    return c || x.chapter ? { ...x, chapter: c ?? x.chapter } : x;
  };
  const out: Moved = { highlights: {}, bookmarks: {}, unsure: 0 };
  for (const h of set.highlights) {
    const where = at[`h${h.id}`];
    if (!where) continue;
    if (!where.found) out.unsure++;
    out.highlights[h.id] = (await placeHighlight(h, where, conv)).map(chapter);
  }
  const reader = new Reader(conv);
  for (const x of set.bookmarks) {
    const where = at[`m${x.id}`];
    if (!where) continue;
    if (!where.found) out.unsure++;
    // Its snippet from the text it is at now (the old one may be the old conversion's garbled text).
    const blk = await reader.block(where.b);
    out.bookmarks[x.id] = chapter({ ...x, b: where.b, o: where.o, ...(blk ? { snippet: snippetAt(blockText(blk), where.o) } : {}) });
  }
  const p = at.place;
  if (p && set.place) out.place = { position: { b: p.b, o: p.o }, percent: conv.totalChars > 0 ? Math.min(1, p.chars / conv.totalChars) : 0 };
  return out;
}

const samePlace = (a?: Position, b?: Position) => !!a && !!b && a.b === b.b && a.o === b.o;

/**
 * A book's annotations with moved marks in place of the ones they were:
 * a book's own (`merge` false) replace theirs by id, keeping what was changed
 * meanwhile (a note, a colour) and leaving out marks deleted meanwhile;
 * a backup's are added where the book doesn't have them.
 */
export function withMoved(cur: { highlights: Highlight[]; bookmarks: Bookmark[] }, set: MarkSet, moved: Moved): { highlights: Highlight[]; bookmarks: Bookmark[] } {
  const hl = new Set(cur.highlights.map((h) => h.id));
  if (set.merge) {
    const bm = new Set(cur.bookmarks.map((x) => x.id));
    return {
      // Placed before (the placing was cut short): not added twice, pieces neither.
      highlights: [...cur.highlights, ...Object.entries(moved.highlights).flatMap(([id, parts]) => (hl.has(id) ? [] : parts.filter((p) => !hl.has(p.id))))],
      bookmarks: [...cur.bookmarks, ...Object.values(moved.bookmarks).filter((x) => !bm.has(x.id))],
    };
  }
  // Pieces of a split highlight from placing this set before: made again now, so not kept twice.
  const again = new Set(Object.entries(moved.highlights).flatMap(([id, parts]) => (hl.has(id) ? parts.slice(1).map((p) => p.id) : [])));
  const where = (p: { b: number; s?: number; e?: number; o?: number; text?: string; snippet?: string; chapter?: string }) => {
    const out: Record<string, unknown> = { b: p.b };
    for (const k of ['s', 'e', 'o', 'text', 'snippet', 'chapter'] as const) if (p[k] !== undefined) out[k] = p[k];
    return out;
  };
  return {
    highlights: cur.highlights.flatMap((h) => {
      const parts = moved.highlights[h.id];
      if (!parts) return again.has(h.id) ? [] : [h];
      return parts.map((p, i) => {
        const part: Highlight = { ...h, ...where(p), id: p.id };
        if (i > 0) delete part.note;
        return part;
      });
    }),
    bookmarks: cur.bookmarks.map((x) => (moved.bookmarks[x.id] ? { ...x, ...where(moved.bookmarks[x.id]) } : x)),
  };
}

/** Below this share of the book, a place a book got since a backup was restored is only where it was opened. */
const JUST_OPENED = 0.01;

/**
 * The reading place after moving: a book's own moves along unless it was
 * changed meanwhile (read on in the new conversion); a backup's replaces the
 * book's when it is newer or the book has none, and when the book had no
 * place when the backup was restored and has only been opened since ("Open
 * with" opens a book at once, at its start). Undefined: keep the book's.
 */
export function movedPlace(
  entry: { position?: Position; percent?: number; openedAt: number },
  set: MarkSet,
  moved: Moved,
): { position: Position; percent: number; openedAt?: number } | undefined {
  if (!set.place || !moved.place) return undefined;
  if (!set.merge) return samePlace(entry.position, set.place.position) ? moved.place : undefined;
  const onlyOpened = set.place.hadPlace === false && (entry.percent ?? 0) < JUST_OPENED;
  if (entry.position && !onlyOpened && (set.place.openedAt ?? 0) <= entry.openedAt) return undefined;
  return { ...moved.place, openedAt: Math.max(entry.openedAt, set.place.openedAt ?? 0) };
}
