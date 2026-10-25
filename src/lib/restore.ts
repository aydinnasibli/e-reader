// A book's data from a backup (see backup.ts), put back on the book: at once
// if it's on this phone, otherwise kept in restore.json until the same book
// file is added (library.ts addFile). Books are recognised by their file's
// fingerprint, whatever the file is called.

import { File, Paths } from 'expo-file-system';
import type { Position } from '@/engine/types';
import { type Annotations, mergeAnnotations } from './annotations';
import type { BookEntry } from './library';
import { type BookStats, mergeBookStats } from './stats';
import { readJson, saveJson } from './storage';

/** What a backup keeps of one book. */
export interface SavedBook {
  /** The book file's fingerprint (fingerprint.ts). */
  fp: string;
  title: string;
  author: string;
  titleEdited?: boolean;
  /** ENGINE_VERSION of the conversion the block numbers below belong to. */
  engine?: number;
  position?: Position;
  percent?: number;
  finished?: boolean;
  openedAt?: number;
  /** Collection names in a backup file; collection ids once restored. */
  collections?: string[];
  annotations: Annotations;
  stats?: BookStats;
}

const file = () => new File(Paths.document, 'restore.json');
let pending: SavedBook[] | null = null;

function all(): SavedBook[] {
  if (!pending) {
    const saved = readJson<SavedBook[]>(file());
    pending = Array.isArray(saved) ? saved : [];
  }
  return pending;
}

function set(list: SavedBook[]) {
  pending = list;
  saveJson(file(), list);
}

/** Keep data for books that aren't on this phone yet. A later backup of the same book replaces an earlier one. */
export function addPending(list: SavedBook[]) {
  const fps = new Set(list.map((b) => b.fp));
  set([...all().filter((b) => !fps.has(b.fp)), ...list]);
}

export function pendingRestores(): readonly SavedBook[] {
  return all();
}

/**
 * Put saved data on a book in the library: its annotations and stats are
 * added; the returned changes are for its library entry. The saved reading
 * place wins when it is newer, or the book has none yet.
 */
export function applySaved(bookId: string, current: BookEntry, saved: SavedBook): Partial<BookEntry> {
  mergeAnnotations(bookId, saved.annotations);
  if (saved.stats) mergeBookStats(bookId, saved.stats);
  const patch: Partial<BookEntry> = {};
  if (saved.position && (!current.position || (saved.openedAt ?? 0) > current.openedAt)) {
    patch.position = saved.position;
    if (saved.percent !== undefined) patch.percent = saved.percent;
    patch.openedAt = Math.max(current.openedAt, saved.openedAt ?? 0);
  }
  if (saved.finished && !current.finished) patch.finished = true;
  if (saved.titleEdited && !current.titleEdited) Object.assign(patch, { title: saved.title, author: saved.author, titleEdited: true });
  const here = current.collections ?? [];
  const cols = [...new Set([...here, ...(saved.collections ?? [])])];
  if (cols.length !== here.length) patch.collections = cols;
  return patch;
}

/** For a book just added: the saved data waiting for it, applied. Null if there is none. */
export function claimPending(bookId: string, current: BookEntry): Partial<BookEntry> | null {
  const saved = current.fp ? all().find((b) => b.fp === current.fp) : undefined;
  if (!saved) return null;
  const patch = applySaved(bookId, current, saved);
  set(all().filter((b) => b !== saved));
  return patch;
}
