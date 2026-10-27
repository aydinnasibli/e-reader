// The shelf as the app holds it: which books exist and their reading
// progress, saved to library.json, and what screens subscribe to
// (useLibrary()/useLiveBook()). The rest of the library (library.ts) changes
// it only through here.

import { File, Paths } from 'expo-file-system';
import type { BookFormat, Manifest, Position } from '@/engine/types';
import { isRecord } from './guards';
import { notice } from './notices';
import { bookDir, imageFile, manifestFile, readJson, saveJson } from './storage';
import { createStore } from './store';

export type BookStatus = 'processing' | 'ready' | 'error';

export interface BookEntry {
  id: string;
  title: string;
  author: string;
  format?: BookFormat;
  fileName: string;
  sourceName: string;
  size: number;
  addedAt: number;
  openedAt: number;
  status: BookStatus;
  /** Conversion progress 0..1 while processing. */
  progress: number;
  error?: string;
  /** Where the reader left off. */
  position?: Position;
  /** Reading progress 0..1, for the shelf. */
  percent?: number;
  /** Cover image file name inside the book's img folder. */
  coverFile?: string;
  /** Collection ids this book belongs to. */
  collections?: string[];
  /** Marked as finished by the reader (or by reaching the end). */
  finished?: boolean;
  /** Conversions started and not finished; a book that keeps killing the app stops being retried. */
  attempts?: number;
  /** Title/author were edited by hand: conversion must not overwrite them. */
  titleEdited?: boolean;
  /** Identity of the original file, to notice it being added again (see fingerprint.ts). */
  fp?: string;
  /** The book's language as set by hand in Book details (two-letter code); overrides the manifest's. */
  lang?: string;
  /** ENGINE_VERSION of the conversion in the book's folder (unknown for books from before it was kept: read from the manifest). */
  engine?: number;
  /** The converter version that failed to convert this book again: it keeps the conversion it has until a newer one. */
  upgradeFailed?: number;
  /** Its original file is gone (an earlier version lost it); adding the same file again repairs the book. */
  sourceMissing?: boolean;
  /** Marks wait in marks.json to be put on its conversion (a backup's, or its own from before "Try again"). */
  marksWaiting?: boolean;
}

/** What the reader needs about a book that is still being converted. */
export interface LiveBook {
  chunks: [number, number][];
  /** Page space of each chunk so far (see Manifest.weights). */
  weights?: number[];
  /** The chunks so far that start a chapter (see Manifest.opens). */
  opens?: number[];
  totalBlocks: number;
  totalChars: number;
  progress: number;
}

/** Shown for a book whose original file an earlier version lost. */
export const MISSING_SOURCE =
  'The book’s file is missing: an earlier version of the app lost it. Add the same file again (or open it with this app again) to repair the book; its highlights, notes and place stay.';

const libraryFile = () => new File(Paths.document, 'library.json');

let books: BookEntry[] = [];
let loaded = false;
const shelf = createStore();
const live = new Map<string, LiveBook>();
const liveStore = createStore();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** The shelf changed: a new array, so screens see it did. */
export function emit() {
  books = [...books];
  shelf.notify();
}

/**
 * The shelf itself, for the library's own modules to change in place (and
 * then emit()). Taken again after anything that emits: emit() makes a new array.
 */
export function bookList(): BookEntry[] {
  return books;
}

export function setBookList(list: BookEntry[]) {
  books = list;
}

export function isLoaded() {
  return loaded;
}

export function markLoaded() {
  loaded = true;
}

const STATUSES: readonly BookStatus[] = ['processing', 'ready', 'error'];

/** A saved entry with what the app can't do without; anything else (a damaged or hand-edited file) is left out. */
function savedEntry(v: unknown): BookEntry[] {
  if (!isRecord(v) || typeof v.id !== 'string' || !v.id || typeof v.sourceName !== 'string' || !STATUSES.includes(v.status as BookStatus)) return [];
  const str = (x: unknown, d: string) => (typeof x === 'string' ? x : d);
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return [
    {
      ...(v as unknown as BookEntry),
      title: str(v.title, 'Untitled'),
      author: str(v.author, ''),
      fileName: str(v.fileName, v.sourceName),
      size: num(v.size),
      addedAt: num(v.addedAt),
      openedAt: num(v.openedAt),
      progress: num(v.progress),
    },
  ];
}

/** library.json as saved (its saved copies if it's damaged); an empty shelf if there's none. */
export function readLibraryFile(): BookEntry[] {
  return (readJson<unknown[]>(libraryFile(), Array.isArray) ?? []).flatMap(savedEntry);
}

/** Save soon: at most every 400 ms, however often things change. */
export function scheduleSave() {
  if (!saveTimer) saveTimer = setTimeout(flushLibrary, 400);
}

/** A failed save is tried again this much later, if nothing saves first. */
const RETRY_MS = 15_000;
/** Told the person that saving the library fails; not again until a save works. */
let warned = false;

/**
 * Save pending changes now (the app is going to the background, or before
 * risky work). A save that fails (the phone is full) keeps the changes in
 * memory, says so once, and is tried again. Returns whether it was saved.
 */
export function flushLibrary(): boolean {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (!loaded) return true;
  if (saveJson(libraryFile(), books)) {
    warned = false;
    return true;
  }
  saveTimer = setTimeout(flushLibrary, RETRY_MS);
  if (!warned) {
    warned = true;
    notice(
      'Couldn’t save',
      'Your reading places and changes to the library couldn’t be saved, probably because the phone is out of space. They’re kept while the app is open and saved as soon as there’s room.',
    );
  }
  return false;
}

export function useLibrary(): BookEntry[] {
  return shelf.useValue(() => books);
}

export function getBook(id: string) {
  return books.find((b) => b.id === id);
}

export function getBooks(): readonly BookEntry[] {
  return books;
}

export function useBook(id: string) {
  const all = useLibrary();
  return all.find((b) => b.id === id);
}

/** Just the status, so subscribers don't re-render on every progress save. */
export function useBookStatus(id: string): BookStatus | undefined {
  return shelf.useValue(() => books.find((b) => b.id === id)?.status);
}

export function updateBook(id: string, patch: Partial<BookEntry>) {
  const i = books.findIndex((b) => b.id === id);
  if (i < 0) return;
  books[i] = { ...books[i], ...patch };
  emit();
  scheduleSave();
}

// ---------- books being converted ----------

export function useLiveBook(id: string): LiveBook | undefined {
  return liveStore.useValue(() => live.get(id));
}

/** A conversion's progress so far (undefined: it's over), for the reader; `quiet`: screens aren't told yet. */
export function setLive(id: string, state: LiveBook | undefined, quiet = false) {
  if (state) live.set(id, state);
  else live.delete(id);
  if (!quiet) liveStore.notify();
}

// ---------- a book's files ----------

const MANIFEST_SHAPE = (v: unknown) => isRecord(v) && Array.isArray(v.chunks);

export function loadManifest(id: string): Manifest | null {
  return readJson<Manifest>(manifestFile(id), MANIFEST_SHAPE);
}

/** A manifest file (a book's, or one in its next/) read the way loadManifest() reads one. */
export function readManifest(file: File): Manifest | null {
  return readJson<Manifest>(file, MANIFEST_SHAPE);
}

export function coverUri(b: BookEntry): string | undefined {
  return b.coverFile ? imageFile(b.id, b.coverFile).uri : undefined;
}

export function sourceFile(b: BookEntry) {
  return new File(bookDir(b.id), b.sourceName);
}

export function sourceExists(b: BookEntry): boolean {
  try {
    return sourceFile(b).exists;
  } catch {
    return false;
  }
}

// ---------- books open in the reader, and backups being made ----------

/** Books open in the reader now: a book converted again is swapped in only once it's closed. */
const openBooks = new Map<string, number>();

/** Count a reader opening (true) or closing (false) a book; returns whether it is still open. */
export function countOpen(id: string, open: boolean): boolean {
  const n = (openBooks.get(id) ?? 0) + (open ? 1 : -1);
  if (n > 0) openBooks.set(id, n);
  else openBooks.delete(id);
  return n > 0;
}

export function isBookOpen(id: string): boolean {
  return openBooks.has(id);
}

/** Backups running: no new conversion is swapped in meanwhile. */
let swapsHeld = 0;

export function holdSwaps(by: 1 | -1): number {
  swapsHeld += by;
  return swapsHeld;
}

export function swapsAreHeld(): boolean {
  return swapsHeld > 0;
}
