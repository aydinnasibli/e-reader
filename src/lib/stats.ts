// Reading time and speed. The reader reports how many characters were read
// over how much time (idle time capped), which gives time-left estimates and
// daily totals.

import { File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { readJson, saveJson } from './storage';

export interface BookStats {
  /** Time spent reading (breaks capped, background and flipping excluded). */
  ms: number;
  /** Older versions' character count (its speed was skewed by fast flipping; unused). */
  chars?: number;
  /** Speed sample: only page turns read at a believable pace. */
  sMs?: number;
  sChars?: number;
}

interface Stats {
  /** Local date "YYYY-MM-DD" -> milliseconds read. */
  days: Record<string, number>;
  books: Record<string, BookStats>;
}

/** Roughly 200 words per minute until we know better. */
export const DEFAULT_CHARS_PER_MIN = 1200;
/** Below this much measured reading, estimates use the default/global speed. */
export const MIN_SAMPLE_MS = 3 * 60_000;
/** Faster than this (about 900 words a minute) is flipping through, not reading. */
export const MAX_CHARS_PER_MIN = 5400;
/** A step this long, too fast to read, is a page flipped (smaller ones are scroll bursts). */
const FLIP_CHARS = 1000;
/** About one screen of text, the least a step's break cap allows for. */
const SCREEN_CHARS = 1500;
/** Shorter stretches of reading aren't used for speed. */
const MIN_RUN_MS = 20_000;

const file = () => new File(Paths.document, 'stats.json');
let stats: Stats | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function get(): Stats {
  if (!stats) stats = { days: {}, books: {}, ...(readJson<Partial<Stats>>(file()) ?? {}) };
  return stats;
}

export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Add reading to the totals: `ms` of reading time, and a speed sample of
 * `sChars` characters read in `sMs` (a subset of that time).
 */
export function recordReading(bookId: string, ms: number, sMs = 0, sChars = 0) {
  if (ms <= 0 && sMs <= 0) return;
  const s = get();
  const day = dayKey();
  const b = s.books[bookId] ?? { ms: 0 };
  stats = {
    days: { ...s.days, [day]: (s.days[day] ?? 0) + ms },
    books: { ...s.books, [bookId]: { ...b, ms: b.ms + ms, sMs: (b.sMs ?? 0) + sMs, sChars: (b.sChars ?? 0) + sChars } },
  };
  listeners.forEach((l) => l());
  if (!saveTimer) saveTimer = setTimeout(flushStats, 2000);
}

/** Save pending reading time now (the app is going to the background). */
export function flushStats() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (stats) saveJson(file(), stats);
}

export function useStats(): Stats {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    get,
  );
}

export function getStats(): Readonly<Stats> {
  return get();
}

function replace(next: Stats) {
  stats = next;
  saveJson(file(), stats);
  listeners.forEach((l) => l());
}

// Stats from a backup: per day and per book, the larger of the two, so that
// restoring onto the phone the backup came from doesn't count anything twice.

export function mergeDays(days: Record<string, number>) {
  const s = get();
  const merged = { ...s.days };
  for (const [day, ms] of Object.entries(days)) merged[day] = Math.max(merged[day] ?? 0, ms);
  replace({ ...s, days: merged });
}

export function mergeBookStats(bookId: string, saved: BookStats) {
  const s = get();
  const here = s.books[bookId];
  if (here && here.ms >= saved.ms) return;
  replace({ ...s, books: { ...s.books, [bookId]: saved } });
}

/**
 * Reading speed (characters a minute) for a book, falling back to the speed
 * over all books, then a default. `measured` is false while it's the default.
 */
export function readingSpeed(bookId?: string): { cpm: number; measured: boolean } {
  const s = get();
  const b = bookId ? s.books[bookId] : undefined;
  if (b?.sMs && b.sMs >= MIN_SAMPLE_MS && b.sChars) return { cpm: (b.sChars / b.sMs) * 60_000, measured: true };
  let ms = 0;
  let chars = 0;
  for (const x of Object.values(s.books)) {
    ms += x.sMs ?? 0;
    chars += x.sChars ?? 0;
  }
  if (ms >= MIN_SAMPLE_MS && chars > 0) return { cpm: (chars / ms) * 60_000, measured: true };
  return { cpm: DEFAULT_CHARS_PER_MIN, measured: false };
}

export function charsPerMinute(bookId?: string): number {
  return readingSpeed(bookId).cpm;
}

export function bookTimeMs(bookId: string) {
  return get().books[bookId]?.ms ?? 0;
}

/**
 * Turns position changes (page turns, or paragraphs scrolling past) into
 * reading time and speed.
 *
 * Time: each step counts up to a cap of about three times what reading it
 * should take; beyond that it was a break. Time in the background doesn't
 * count (pause/resume); the page open when reading stops does.
 *
 * Speed comes from stretches of continuous reading: a stretch ends at a
 * break, a jump, going back, or flipping through (whole pages faster than
 * anyone reads), and only counts if its overall pace is believable. Judging
 * whole stretches rather than single steps makes scroll mode work, where
 * paragraphs pass in quick bursts between long reads of the screen.
 */
export class ReadingTracker {
  /** When the clock last started on the current position; null while paused. */
  private at: number | null;
  /** Time already spent on the current position before a pause. */
  private pending = 0;
  private char: number | null = null;
  // The current stretch of continuous reading: where it started, and time in it.
  private runChar: number | null = null;
  private runMs = 0;
  // Totals not yet recorded.
  private ms = 0;
  private sMs = 0;
  private sChars = 0;
  private flushAt: number;

  constructor(
    private bookId: string,
    private now: () => number = Date.now,
    private speed: () => number = () => charsPerMinute(bookId),
  ) {
    this.at = now();
    this.flushAt = this.at;
  }

  /** Longest believable time for a step of `chars` characters (at least a screenful). */
  private cap(chars: number) {
    const expected = (Math.max(chars, SCREEN_CHARS) / this.speed()) * 60_000;
    return Math.min(10 * 60_000, Math.max(60_000, expected * 3));
  }

  /** Close the current stretch (up to the current position) and start a new one there. */
  private endRun() {
    const chars = this.char !== null && this.runChar !== null ? this.char - this.runChar : 0;
    if (this.runMs >= MIN_RUN_MS && chars > 0 && (chars / this.runMs) * 60_000 <= MAX_CHARS_PER_MIN) {
      this.sMs += this.runMs;
      this.sChars += chars;
    }
    this.runChar = this.char;
    this.runMs = 0;
  }

  /** Move to `char` and start a new stretch there. */
  private restart(char: number) {
    this.endRun();
    this.char = char;
    this.runChar = char;
  }

  /** Time on the current position so far, up to what a page could believably take. */
  private settle(now: number) {
    if (this.char !== null && this.at !== null) this.ms += Math.max(0, Math.min(now - this.at, this.cap(0) - this.pending));
    this.pending = 0;
    this.at = now;
    if (now - this.flushAt > 30_000) this.flush();
  }

  /** A jump: the time on the page jumped from counts; start a new stretch here. */
  reset(char: number) {
    this.settle(this.now());
    this.restart(char);
  }

  /**
   * A page turned (or scrolled) by auto page turn: the time counts as reading,
   * but the pace is the machine's, so it isn't a sample of the reader's speed.
   */
  autoTurn(char: number) {
    this.reset(char);
  }

  turn(char: number) {
    const now = this.now();
    if (this.at === null) this.at = now; // a turn while paused shouldn't happen; treat as resumed
    if (this.char === null) {
      this.reset(char);
      return;
    }
    const live = now - this.at;
    const dt = this.pending + live; // whole time spent on the position just left
    const d = char - this.char;
    const cap = this.cap(Math.abs(d));
    if (d >= 0 && d < 12_000) {
      if (d >= FLIP_CHARS && dt < (d / MAX_CHARS_PER_MIN) * 60_000) {
        // Flipping through whole pages: not reading. What came before stands.
        this.restart(char);
      } else if (dt > cap) {
        // A break: capped time; the stretch before it stands, this step isn't a sample.
        this.ms += Math.max(0, Math.min(live, cap - this.pending));
        this.restart(char);
      } else {
        this.ms += live;
        this.runMs += dt;
        this.char = char;
      }
    } else if (d < 0 && d > -12_000) {
      // Going back to re-read: time, but a new stretch.
      this.ms += Math.max(0, Math.min(live, cap - this.pending));
      this.restart(char);
    } else {
      this.restart(char);
    }
    this.pending = 0;
    this.at = now;
    if (now - this.flushAt > 30_000) this.flush();
  }

  /** The app goes to the background: time so far on this page counts, the clock stops. */
  pause() {
    if (this.at === null) return;
    const add = Math.max(0, Math.min(this.now() - this.at, this.cap(0) - this.pending));
    this.pending += add;
    this.ms += add;
    this.at = null;
    // Steps completed so far are a finished stretch; the open page carries over.
    this.endRun();
    this.flush();
  }

  /** Back in the app: the current page continues from now. */
  resume() {
    if (this.at === null) this.at = this.now();
  }

  /** Reading ends (the book is closed). */
  stop() {
    this.pause();
    this.flush();
  }

  flush() {
    recordReading(this.bookId, this.ms, this.sMs, this.sChars);
    this.ms = 0;
    this.sMs = 0;
    this.sChars = 0;
    this.flushAt = this.now();
  }
}
