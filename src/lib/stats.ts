// Reading time and speed. The reader reports how many characters were read
// over how much time (idle time capped), which gives time-left estimates and
// daily totals.

import { File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { readJson, saveJson } from './storage';

interface BookStats {
  ms: number;
  chars: number;
}

interface Stats {
  /** Local date "YYYY-MM-DD" -> milliseconds read. */
  days: Record<string, number>;
  books: Record<string, BookStats>;
}

/** Roughly 220 words per minute until we know better. */
export const DEFAULT_CHARS_PER_MIN = 1200;
/** Below this much measured reading, estimates use the default/global speed. */
const MIN_SAMPLE_MS = 3 * 60_000;

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

export function recordReading(bookId: string, ms: number, chars: number) {
  if (ms <= 0) return;
  const s = get();
  const day = dayKey();
  const b = s.books[bookId] ?? { ms: 0, chars: 0 };
  stats = {
    days: { ...s.days, [day]: (s.days[day] ?? 0) + ms },
    books: { ...s.books, [bookId]: { ms: b.ms + ms, chars: b.chars + Math.max(0, chars) } },
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

/** Reading speed for a book, falling back to the overall speed, then a default. */
export function charsPerMinute(bookId?: string): number {
  const s = get();
  const b = bookId ? s.books[bookId] : undefined;
  if (b && b.ms >= MIN_SAMPLE_MS && b.chars > 0) return (b.chars / b.ms) * 60_000;
  let ms = 0;
  let chars = 0;
  for (const x of Object.values(s.books)) {
    ms += x.ms;
    chars += x.chars;
  }
  if (ms >= MIN_SAMPLE_MS && chars > 0) return (chars / ms) * 60_000;
  return DEFAULT_CHARS_PER_MIN;
}

export function bookTimeMs(bookId: string) {
  return get().books[bookId]?.ms ?? 0;
}

/**
 * Turns page-turn events into reading time. Time between two turns counts
 * only up to a cap (so leaving the phone on the table doesn't count), and
 * big jumps (contents, slider, search) aren't counted as reading.
 */
export class ReadingTracker {
  private lastAt = Date.now();
  private lastChar: number | null = null;
  private ms = 0;
  private chars = 0;
  private flushAt = Date.now();

  constructor(private bookId: string) {}

  /** A jump: start counting from here. */
  reset(char: number) {
    this.lastChar = char;
    this.lastAt = Date.now();
  }

  turn(char: number) {
    const now = Date.now();
    if (this.lastChar !== null) {
      const dChars = char - this.lastChar;
      const dt = now - this.lastAt;
      // Count forward reading of up to ~2 pages per turn, and at most 3 minutes per page.
      if (dChars > 0 && dChars < 6000) {
        this.chars += dChars;
        this.ms += Math.min(dt, 3 * 60_000);
      } else if (dChars <= 0 && dChars > -6000) {
        this.ms += Math.min(dt, 60_000);
      }
    }
    this.lastChar = char;
    this.lastAt = now;
    if (now - this.flushAt > 30_000) this.flush();
  }

  flush() {
    recordReading(this.bookId, this.ms, this.chars);
    this.ms = 0;
    this.chars = 0;
    this.flushAt = Date.now();
  }
}
