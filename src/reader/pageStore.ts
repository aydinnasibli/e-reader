// The page size measured for each layout a book was read in (see
// pageNumbers.ts), kept in books/<id>/pages.json: the same settings give the
// same page numbers every time the book is opened. The library deletes the
// file when the book is converted again.

import { File, Paths } from 'expo-file-system';
import { readJson, saveJson } from '@/lib/storage';

interface Stored {
  v: 1;
  /** The book's total weight when it was saved (complete books): a book that changed since starts over. */
  weight?: number;
  /** Layout key -> weight a page holds; most recently measured last. */
  layouts: Record<string, number>;
}

/** Layouts remembered per book: plenty for the settings anyone switches between. */
const KEEP = 40;

const fileOf = (id: string) => new File(Paths.document, 'books', id, 'pages.json');

/** The page sizes saved for a book; `weight`: its total weight now, if it's complete. */
export function loadPageSizes(id: string, weight?: number): Map<string, number> {
  let s: Stored | null = null;
  try {
    s = readJson<Stored>(fileOf(id));
  } catch {
    s = null;
  }
  if (!s || s.v !== 1 || typeof s.layouts !== 'object' || !s.layouts) return new Map();
  if (weight !== undefined && s.weight !== undefined && Math.abs(s.weight - weight) > 0.5) return new Map();
  return new Map(Object.entries(s.layouts).filter(([, v]) => typeof v === 'number' && v > 0));
}

export function savePageSizes(id: string, sizes: Map<string, number>, weight?: number) {
  const layouts: Record<string, number> = {};
  for (const [k, v] of [...sizes].slice(-KEEP)) layouts[k] = v;
  try {
    saveJson(fileOf(id), { v: 1, weight, layouts } satisfies Stored);
  } catch {
    // Not saved: the numbers are measured again next time.
  }
}
