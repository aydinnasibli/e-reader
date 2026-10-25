// Bookmarks and highlights (with optional notes), stored per book in
// books/<id>/annotations.json. Positions use block index + character offset
// within the block, so they survive font and layout changes.

import { File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { Alert } from 'react-native';
import type { HighlightColor } from '@/ui/theme';
import { cutRange } from './highlightRanges';
import { readJson, writeJson } from './storage';

export interface Bookmark {
  id: string;
  b: number;
  o: number;
  snippet: string;
  chapter?: string;
  createdAt: number;
}

export interface Highlight {
  id: string;
  /** Block index and [s, e) character range inside it. */
  b: number;
  s: number;
  e: number;
  color: HighlightColor;
  text: string;
  note?: string;
  chapter?: string;
  createdAt: number;
}

export interface Annotations {
  bookmarks: Bookmark[];
  highlights: Highlight[];
}

const EMPTY: Annotations = { bookmarks: [], highlights: [] };
const cache = new Map<string, Annotations>();
const byBlock = new Map<string, Map<number, Highlight[]>>();
const listeners = new Set<() => void>();
/** Bumped on every change, for screens that show several books' annotations. */
let version = 0;

const file = (bookId: string) => new File(Paths.document, 'books', bookId, 'annotations.json');

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function getAnnotations(bookId: string): Annotations {
  let a = cache.get(bookId);
  if (!a) {
    a = readJson<Annotations>(file(bookId)) ?? EMPTY;
    cache.set(bookId, a);
  }
  return a;
}

/** Books whose latest annotations aren't on disk yet (a save failed: storage full, file locked). */
const unsaved = new Set<string>();
/** Told the person that saving fails; not again until a save works. */
let warned = false;

function write(bookId: string): boolean {
  const a = cache.get(bookId);
  if (!a) return true;
  try {
    writeJson(file(bookId), a);
    unsaved.delete(bookId);
    return true;
  } catch {
    // The book was deleted meanwhile: nothing to keep.
    if (!file(bookId).parentDirectory.exists) {
      unsaved.delete(bookId);
      return true;
    }
    unsaved.add(bookId);
    return false;
  }
}

/**
 * Write annotations whose earlier save failed. Called before every save and
 * when the app goes to the background. Returns whether everything is saved.
 */
export function flushAnnotations(): boolean {
  for (const id of [...unsaved]) write(id);
  if (!unsaved.size) warned = false;
  return unsaved.size === 0;
}

function save(bookId: string, a: Annotations) {
  cache.set(bookId, a);
  byBlock.delete(bookId);
  // The change stays in memory (and on screen) and is written again later:
  // a highlight must not vanish when the app is next closed.
  flushAnnotations();
  if (!write(bookId) && !warned) {
    warned = true;
    Alert.alert('Couldn’t save', 'Your highlights and bookmarks couldn’t be saved, probably because the phone is out of space. They’re kept while the app is open and saved as soon as there’s room.');
  } else if (!unsaved.size) warned = false;
  version++;
  listeners.forEach((l) => l());
}

/** Changes whenever any book's annotations change. */
export function useAnnotationsVersion(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}

export function useAnnotations(bookId: string): Annotations {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => getAnnotations(bookId),
  );
}

/** Highlights grouped by block, for drawing. Stable until annotations change. */
export function highlightsByBlock(bookId: string): Map<number, Highlight[]> {
  let m = byBlock.get(bookId);
  if (!m) {
    m = new Map();
    for (const h of getAnnotations(bookId).highlights) {
      const list = m.get(h.b);
      if (list) list.push(h);
      else m.set(h.b, [h]);
    }
    byBlock.set(bookId, m);
  }
  return m;
}

const byPosition = (a: { b: number; o?: number; s?: number }, b: { b: number; o?: number; s?: number }) =>
  a.b - b.b || (a.o ?? a.s ?? 0) - (b.o ?? b.s ?? 0);

export function addBookmark(bookId: string, bm: Omit<Bookmark, 'id' | 'createdAt'>) {
  const a = getAnnotations(bookId);
  save(bookId, { ...a, bookmarks: [...a.bookmarks, { ...bm, id: newId(), createdAt: Date.now() }].sort(byPosition) });
}

export function removeBookmark(bookId: string, id: string) {
  const a = getAnnotations(bookId);
  save(bookId, { ...a, bookmarks: a.bookmarks.filter((x) => x.id !== id) });
}

export function addHighlight(bookId: string, h: Omit<Highlight, 'id' | 'createdAt'>): Highlight {
  const a = getAnnotations(bookId);
  const full = { ...h, id: newId(), createdAt: Date.now() };
  // The new highlight takes over its range; older ones keep the parts outside it.
  const rest = cutRange(a.highlights, h.b, h.s, h.e, newId);
  save(bookId, { ...a, highlights: [...rest, full].sort(byPosition) });
  return full;
}

/** Remove highlighting from [s, e) of a block, trimming or splitting highlights. */
export function clearHighlightRange(bookId: string, b: number, s: number, e: number) {
  const a = getAnnotations(bookId);
  save(bookId, { ...a, highlights: cutRange(a.highlights, b, s, e, newId).sort(byPosition) });
}

export function updateHighlight(bookId: string, id: string, patch: Partial<Pick<Highlight, 'color' | 'note'>>) {
  const a = getAnnotations(bookId);
  save(bookId, { ...a, highlights: a.highlights.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
}

export function removeHighlight(bookId: string, id: string) {
  const a = getAnnotations(bookId);
  save(bookId, { ...a, highlights: a.highlights.filter((x) => x.id !== id) });
}

/**
 * Add annotations from a backup: ones already here (same id) stay as they
 * are, the others are added. Returns how many were added.
 */
export function mergeAnnotations(bookId: string, incoming: Annotations): number {
  const a = getAnnotations(bookId);
  const hl = new Set(a.highlights.map((h) => h.id));
  const bm = new Set(a.bookmarks.map((x) => x.id));
  const highlights = incoming.highlights.filter((h) => !hl.has(h.id));
  const bookmarks = incoming.bookmarks.filter((x) => !bm.has(x.id));
  if (!highlights.length && !bookmarks.length) return 0;
  save(bookId, { highlights: [...a.highlights, ...highlights].sort(byPosition), bookmarks: [...a.bookmarks, ...bookmarks].sort(byPosition) });
  return highlights.length + bookmarks.length;
}

export function forgetAnnotations(bookId: string) {
  unsaved.delete(bookId);
  cache.delete(bookId);
  byBlock.delete(bookId);
}
