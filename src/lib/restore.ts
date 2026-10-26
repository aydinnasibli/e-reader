// A book's data from a backup (see backup.ts), put back on the book: at once
// if it's on this phone, otherwise kept in restore.json until the same book
// file is added (library.ts addFile). Books are recognised by their file's
// fingerprint, whatever the file is called. Marks are block numbers of the
// conversion the backup was made from: where this phone's conversion of the
// book is another (another converter version), they are found again by their
// text once the book is ready (remap.ts).

import { File, Paths } from 'expo-file-system';
import { ENGINE_VERSION, type Position } from '@/engine/types';
import { type Annotations, mergeAnnotations } from './annotations';
// Types only: the library calls in here (claimPending), and passes its queueMarks to what needs it.
import type { BookEntry } from './library';
import { type Anchor, type MarkSet, marksOf, savedAnchors } from './remap';
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
  /**
   * Where each mark is in that conversion, with its text and the text around
   * it (remap.ts; `h<id>`, `m<id>`, `place`), to find it in another one.
   * Highlights' anchors leave out their text: it's the highlight's own.
   */
  anchors?: Record<string, Anchor>;
  /** The book's language as set by hand. */
  lang?: string;
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

function set(list: SavedBook[]): boolean {
  pending = list;
  return saveJson(file(), list);
}

/**
 * Keep data for books that aren't on this phone yet. A later backup of the
 * same book replaces an earlier one. False if it couldn't be saved (the
 * phone is full): it's kept only until the app is closed.
 */
export function addPending(list: SavedBook[]): boolean {
  const fps = new Set(list.map((b) => b.fp));
  return set([...all().filter((b) => !fps.has(b.fp)), ...list]);
}

export function pendingRestores(): readonly SavedBook[] {
  return all();
}

/**
 * A backup's marks and place, to be found by their text on another
 * conversion of the book. `hadPlace`: the book had a reading place of its own
 * when the backup was restored (if not, one it gets only by being opened
 * before the marks are placed doesn't count against the backup's).
 */
export function savedMarkSet(saved: SavedBook, hadPlace?: boolean): MarkSet {
  const { highlights, bookmarks } = saved.annotations;
  const anchors = savedAnchors(marksOf(highlights, bookmarks, saved.position));
  // A backup from before anchors were kept: the place is best found at the same share of the book.
  if (anchors.place && saved.percent !== undefined) anchors.place = { at: saved.percent, text: '' };
  for (const [key, a] of Object.entries(saved.anchors ?? {})) {
    if (!(key in anchors)) continue;
    anchors[key] = { ...a, text: a.text ?? anchors[key].text };
  }
  return {
    merge: true,
    highlights,
    bookmarks,
    anchors,
    ...(saved.position ? { place: { position: saved.position, percent: saved.percent, openedAt: saved.openedAt, ...(hadPlace !== undefined ? { hadPlace } : {}) } } : {}),
  };
}

/** Keeps marks to be placed on a book once it's ready (library.ts queueMarks). */
export type QueueMarks = (bookId: string, set: MarkSet) => void;

/**
 * Put saved data on a book in the library: its annotations and stats are
 * added; the returned changes are for its library entry. The saved reading
 * place wins when it is newer, or the book has none yet. `here`: the
 * converter version of the book's conversion on this phone (the one it is
 * about to get, for a book being converted); when it isn't the backup's, the
 * marks and place are handed to `queue`, to be found by their text once the
 * book is ready.
 */
export function applySaved(bookId: string, current: BookEntry, saved: SavedBook, here: number | undefined, queue: QueueMarks): Partial<BookEntry> {
  const patch: Partial<BookEntry> = {};
  const { highlights, bookmarks } = saved.annotations;
  const marks = highlights.length + bookmarks.length > 0 || !!saved.position;
  if (marks && (saved.engine === undefined || saved.engine !== here)) {
    // Throws if it can't be saved (a full phone): the caller says so.
    queue(bookId, savedMarkSet(saved, !!current.position));
    patch.marksWaiting = true;
  } else {
    mergeAnnotations(bookId, saved.annotations);
    if (saved.position && (!current.position || (saved.openedAt ?? 0) > current.openedAt)) {
      patch.position = saved.position;
      if (saved.percent !== undefined) patch.percent = saved.percent;
      patch.openedAt = Math.max(current.openedAt, saved.openedAt ?? 0);
    }
  }
  if (saved.stats) mergeBookStats(bookId, saved.stats);
  if (saved.finished && !current.finished) patch.finished = true;
  if (saved.titleEdited && !current.titleEdited) Object.assign(patch, { title: saved.title, author: saved.author, titleEdited: true });
  if (saved.lang && !current.lang) patch.lang = saved.lang;
  const mine = current.collections ?? [];
  const cols = [...new Set([...mine, ...(saved.collections ?? [])])];
  if (cols.length !== mine.length) patch.collections = cols;
  return patch;
}

/** For a book just added: the saved data waiting for it, applied. Null if there is none. */
export function claimPending(bookId: string, current: BookEntry, queue: QueueMarks): Partial<BookEntry> | null {
  const saved = current.fp ? all().find((b) => b.fp === current.fp) : undefined;
  if (!saved) return null;
  // It is about to be converted by this version of the converter.
  const patch = applySaved(bookId, current, saved, ENGINE_VERSION, queue);
  set(all().filter((b) => b !== saved));
  return patch;
}
