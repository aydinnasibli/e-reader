// Bookmarks and highlights (with optional notes), stored per book in
// books/<id>/annotations.json. Positions use block index + character offset
// within the block, so they survive font and layout changes.

import { File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import type { HighlightColor } from '@/ui/theme';
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

function save(bookId: string, a: Annotations) {
  cache.set(bookId, a);
  byBlock.delete(bookId);
  try {
    writeJson(file(bookId), a);
  } catch {
    // the book may have been deleted meanwhile
  }
  listeners.forEach((l) => l());
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
  // A new highlight replaces any it overlaps in the same block.
  const rest = a.highlights.filter((x) => !(x.b === h.b && x.s < h.e && h.s < x.e));
  save(bookId, { ...a, highlights: [...rest, full].sort(byPosition) });
  return full;
}

export function updateHighlight(bookId: string, id: string, patch: Partial<Pick<Highlight, 'color' | 'note'>>) {
  const a = getAnnotations(bookId);
  save(bookId, { ...a, highlights: a.highlights.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
}

export function removeHighlight(bookId: string, id: string) {
  const a = getAnnotations(bookId);
  save(bookId, { ...a, highlights: a.highlights.filter((x) => x.id !== id) });
}

export function forgetAnnotations(bookId: string) {
  cache.delete(bookId);
  byBlock.delete(bookId);
}
