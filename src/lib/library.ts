// The shelf: which books exist, their reading progress, and the background
// job that converts newly imported files. A tiny observable store; screens
// subscribe with useLibrary()/useLiveBook().

import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { ingestBook, isSupportedName, titleFromFileName } from '@/engine/ingest';
import type { BookFormat, Manifest, Position } from '@/engine/types';
import { forgetAnnotations } from './annotations';
import { fingerprintOf } from './fingerprint';
import {
  FileSink,
  FileSource,
  bookDir,
  booksDir,
  ensureDir,
  imageFile,
  manifestFile,
  readJson,
  saveJson,
  writeJson,
} from './storage';

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
}

/** What the reader needs about a book that is still being converted. */
export interface LiveBook {
  chunks: [number, number][];
  totalBlocks: number;
  totalChars: number;
  progress: number;
}

const libraryFile = () => new File(Paths.document, 'library.json');

let books: BookEntry[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const live = new Map<string, LiveBook>();
const liveListeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  books = [...books];
  listeners.forEach((l) => l());
}

function emitLive() {
  liveListeners.forEach((l) => l());
}

/** Save soon: at most every 400 ms, however often things change. */
function scheduleSave() {
  if (!saveTimer) saveTimer = setTimeout(flushLibrary, 400);
}

/** Save pending changes now (the app is going to the background, or before risky work). */
export function flushLibrary() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (loaded) saveJson(libraryFile(), books);
}

const MAX_ATTEMPTS = 2;

export function loadLibrary() {
  if (loaded) return;
  loaded = true;
  ensureDir(booksDir());
  books = readJson<BookEntry[]>(libraryFile()) ?? [];
  for (const b of books) {
    if (b.status !== 'processing') continue;
    // Interrupted mid-conversion (app closed) starts over, unless converting
    // it is what keeps closing the app.
    b.progress = 0;
    if ((b.attempts ?? 0) >= MAX_ATTEMPTS) {
      b.status = 'error';
      b.error = 'Preparing this book stopped the app. The file may be damaged or unusual.';
    }
  }
  recoverOrphans();
  emit();
  void runQueue();
}

/**
 * Book folders the library doesn't list (the list was lost, or the app died
 * right after an import): put books back on the shelf, drop empty leftovers.
 */
function recoverOrphans() {
  let dirs: Directory[];
  try {
    dirs = booksDir().list().filter((d): d is Directory => d instanceof Directory);
  } catch {
    return;
  }
  const known = new Set(books.map((b) => b.id));
  let changed = false;
  for (const d of dirs) {
    if (known.has(d.name)) continue;
    try {
      const source = d.list().find((f): f is File => f instanceof File && f.name.startsWith('source.'));
      if (!source) {
        d.delete();
        continue;
      }
      const m = readJson<Manifest>(manifestFile(d.name));
      const now = Date.now();
      books.push({
        id: d.name,
        title: m?.title || 'Recovered book',
        author: m?.author ?? '',
        format: m?.format,
        fileName: source.name,
        sourceName: source.name,
        size: source.size,
        addedAt: now,
        openedAt: 0,
        status: m ? 'ready' : 'processing',
        progress: m ? 1 : 0,
      });
      changed = true;
    } catch {
      // leave it for next time
    }
  }
  if (changed) scheduleSave();
}

export function useLibrary(): BookEntry[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => books,
  );
}

export function getBook(id: string) {
  return books.find((b) => b.id === id);
}

export function useBook(id: string) {
  const all = useLibrary();
  return all.find((b) => b.id === id);
}

/** Just the status, so subscribers don't re-render on every progress save. */
export function useBookStatus(id: string): BookStatus | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => books.find((b) => b.id === id)?.status,
  );
}

export function useLiveBook(id: string): LiveBook | undefined {
  return useSyncExternalStore(
    (l) => {
      liveListeners.add(l);
      return () => liveListeners.delete(l);
    },
    () => live.get(id),
  );
}

export function updateBook(id: string, patch: Partial<BookEntry>) {
  const i = books.findIndex((b) => b.id === id);
  if (i < 0) return;
  books[i] = { ...books[i], ...patch };
  emit();
  scheduleSave();
}

export function loadManifest(id: string): Manifest | null {
  return readJson<Manifest>(manifestFile(id));
}

export function coverUri(b: BookEntry): string | undefined {
  return b.coverFile ? imageFile(b.id, b.coverFile).uri : undefined;
}

export function sourceFile(b: BookEntry) {
  return new File(bookDir(b.id), b.sourceName);
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export interface ImportResult {
  added: number;
  /** Not a supported format. */
  skipped: string[];
  /** Couldn't be copied (usually storage full). */
  failed: string[];
  /** Already on the shelf: [file name, title of the book on the shelf]. */
  duplicates: [string, string][];
}

/** Fingerprint of a file, or undefined when it can't be read. */
function fingerprintFile(file: File): string | undefined {
  let src: FileSource | undefined;
  try {
    src = new FileSource(file);
    return fingerprintOf(src);
  } catch {
    return undefined;
  } finally {
    src?.close();
  }
}

/**
 * The book on the shelf that is this file, if any. Books added by older
 * versions get their fingerprint here, the first time a file of the same
 * size comes in.
 */
function findDuplicate(fp: string, size: number): BookEntry | undefined {
  for (const b of books) {
    if (b.status === 'error') continue;
    if (!b.fp && b.size === size) {
      const f = fingerprintFile(sourceFile(b));
      if (f) b.fp = f;
    }
    if (b.fp === fp) return b;
  }
  return undefined;
}

/** Let the user pick files and add them to the shelf. */
export async function importBooks(): Promise<ImportResult> {
  const res = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true });
  if (res.canceled) return { added: 0, skipped: [], failed: [], duplicates: [] };
  const skipped: string[] = [];
  const failed: string[] = [];
  const duplicates: [string, string][] = [];
  let backfilled = false;
  let added = 0;
  try {
    for (const asset of res.assets) {
      if (!isSupportedName(asset.name)) {
        skipped.push(asset.name);
        continue;
      }
      const picked = new File(asset.uri);
      const size = asset.size ?? picked.size;
      const fp = fingerprintFile(picked);
      if (fp) {
        const known = books.some((b) => !b.fp && b.size === size);
        const dup = findDuplicate(fp, size);
        backfilled ||= known;
        if (dup) {
          duplicates.push([asset.name, dup.title]);
          try {
            picked.delete(); // the picker's private copy
          } catch {
            // the cache is cleared by the system anyway
          }
          continue;
        }
      }
      const id = newId();
      const dir = bookDir(id);
      try {
        ensureDir(dir);
        const lower = asset.name.toLowerCase();
        const ext = lower.endsWith('.fb2.zip') ? 'fb2.zip' : (lower.split('.').pop() ?? 'bin');
        const dest = new File(dir, `source.${ext}`);
        // The picker already made a private copy; moving it is instant even for huge files.
        try {
          picked.moveSync(dest);
        } catch {
          picked.copySync(dest);
        }
        const now = Date.now();
        books.unshift({
          id,
          title: titleFromFileName(asset.name),
          author: '',
          fileName: asset.name,
          sourceName: dest.name,
          size: dest.size,
          addedAt: now,
          openedAt: now,
          status: 'processing',
          progress: 0,
          ...(fp ? { fp } : {}),
        });
        added++;
      } catch {
        // Usually storage full. Don't leave a half-copied book behind.
        failed.push(asset.name);
        try {
          if (dir.exists) dir.delete();
        } catch {
          // recoverOrphans() tidies it next launch
        }
      }
    }
  } finally {
    if (added) {
      emit();
      flushLibrary();
      void runQueue();
    } else if (backfilled) scheduleSave();
  }
  return { added, skipped, failed, duplicates };
}

/** Edit a book's title and/or author; kept even if the book is converted again. */
export function renameBook(id: string, patch: { title?: string; author?: string }) {
  const title = patch.title?.trim();
  const author = patch.author?.trim();
  updateBook(id, { ...(title ? { title } : {}), ...(author !== undefined ? { author } : {}), titleEdited: true });
}

/** Go back to the title and author the book file itself gives. */
export function restoreBookTitle(id: string) {
  const m = loadManifest(id);
  const b = getBook(id);
  if (!b) return;
  updateBook(id, { title: m?.title || titleFromFileName(b.fileName), author: m?.author ?? '', titleEdited: false });
}

/** Convert a book again from its original file (after damage or an engine upgrade). */
export function reprocessBook(id: string) {
  updateBook(id, { status: 'processing', progress: 0, error: undefined, attempts: 0 });
  void runQueue();
}

export function deleteBook(id: string) {
  books = books.filter((b) => b.id !== id);
  live.delete(id);
  forgetAnnotations(id);
  emit();
  flushLibrary();
  try {
    const d = bookDir(id);
    if (d.exists) d.delete();
  } catch {
    // leftover files are harmless
  }
}

// ---------- background conversion ----------

let running = false;

async function runQueue() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const next = books.find((b) => b.status === 'processing');
      if (!next) break;
      await convert(next);
    }
  } finally {
    running = false;
  }
}

/** Yield to the UI whenever we've worked for a few milliseconds. */
function makePause() {
  let last = Date.now();
  return async () => {
    if (Date.now() - last < 12) return;
    await new Promise((r) => setTimeout(r, 1));
    last = Date.now();
  };
}

async function convert(book: BookEntry) {
  const id = book.id;
  const dir = bookDir(id);
  // Start clean: remove output from an interrupted earlier attempt.
  for (const sub of ['c', 'img']) {
    try {
      const d = new Directory(dir, sub);
      if (d.exists) d.delete();
    } catch {
      // ignore
    }
  }
  try {
    const m = manifestFile(id);
    if (m.exists) m.delete();
  } catch {
    // ignore
  }

  // Count the attempt on disk before starting, so a book whose conversion
  // kills the app isn't retried forever (see loadLibrary).
  updateBook(id, { attempts: (book.attempts ?? 0) + 1 });
  flushLibrary();

  const state: LiveBook = { chunks: [], totalBlocks: 0, totalChars: 0, progress: 0 };
  live.set(id, state);
  let lastEmit = 0;
  // Progress goes to the live store only: it changes many times a second and
  // isn't worth saving (an interrupted conversion starts over anyway).
  const publish = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 250) return;
    lastEmit = now;
    live.set(id, { ...state, chunks: state.chunks.slice() });
    emitLive();
  };

  let src: FileSource | null = null;
  try {
    src = new FileSource(sourceFile(book));
    const sink = new FileSink(id, (index, info) => {
      state.chunks[index] = [info.firstBlock, info.firstChar];
      state.totalBlocks = info.firstBlock + info.blocks;
      state.totalChars = info.firstChar + info.chars;
      // The very first chunk is published right away so the book can be opened.
      publish(index === 0);
    });
    const manifest = await ingestBook(
      {
        src,
        sink,
        progress: (f) => {
          state.progress = f;
          publish();
        },
        pause: makePause(),
        fallbackTitle: book.title,
        meta: (info) => {
          const patch: Partial<BookEntry> = {};
          const edited = getBook(id)?.titleEdited;
          if (info.title && !edited) patch.title = info.title;
          if (info.author && !edited) patch.author = info.author;
          if (info.coverFile) patch.coverFile = info.coverFile;
          updateBook(id, patch);
        },
      },
      book.fileName,
    );
    writeJson(manifestFile(id), manifest);
    const coverRef = manifest.cover ? manifest.images[manifest.cover] : undefined;
    const edited = getBook(id)?.titleEdited;
    updateBook(id, {
      status: 'ready',
      progress: 1,
      attempts: undefined,
      ...(edited ? {} : { title: manifest.title, author: manifest.author }),
      format: manifest.format,
      coverFile: coverRef && 'file' in coverRef ? coverRef.file : getBook(id)?.coverFile,
    });
  } catch (e) {
    updateBook(id, { status: 'error', error: e instanceof Error ? e.message : String(e), attempts: undefined });
  } finally {
    src?.close();
    live.delete(id);
    emitLive();
  }
}
