// The shelf: which books exist, their reading progress, and the background
// job that converts newly imported files. A tiny observable store; screens
// subscribe with useLibrary()/useLiveBook().

import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import {
  bookExtension,
  bookFileName,
  describeError,
  friendlyStoredError,
  ingestBook,
  isSupportedName,
  type SniffedFormat,
  sniffFormat,
  titleFromFileName,
} from '@/engine/ingest';
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
    if (b.status === 'error') b.error = friendlyStoredError(b.error);
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
  AppState.addEventListener('change', (s) => {
    if (s === 'active') countAttempt(true);
    else if (s === 'background') countAttempt(false);
  });
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
 * size comes in. A book that failed to prepare counts too: adding it again
 * would only add another failed copy, and the one on the shelf offers to
 * try again.
 */
function findDuplicate(fp: string, size: number): BookEntry | undefined {
  for (const b of books) {
    if (!b.fp && b.size === size) {
      const f = fingerprintFile(sourceFile(b));
      if (f) b.fp = f;
    }
    if (b.fp === fp) return b;
  }
  return undefined;
}

type AddOutcome = { added: BookEntry } | { duplicate: BookEntry } | { failed: true };

/**
 * Put one file on the shelf by moving it into the book's folder; a file
 * that is already on the shelf is dropped instead. `file` must be the app's
 * own copy (the picker's, or one made of a shared file). The caller saves
 * and starts conversion with finishAdding().
 */
function addFile(file: File, name: string, size: number): AddOutcome {
  const fp = fingerprintFile(file);
  const dup = fp ? findDuplicate(fp, size) : undefined;
  if (dup) {
    try {
      file.delete();
    } catch {
      // the cache is cleared by the system anyway
    }
    return { duplicate: dup };
  }
  const id = newId();
  const dir = bookDir(id);
  try {
    ensureDir(dir);
    const dest = new File(dir, `source.${bookExtension(name) ?? 'bin'}`);
    // Already our own copy: moving it is instant even for huge files.
    try {
      file.moveSync(dest);
    } catch {
      file.copySync(dest);
    }
    const now = Date.now();
    const book: BookEntry = {
      id,
      title: titleFromFileName(name),
      author: '',
      fileName: name,
      sourceName: dest.name,
      size: dest.size,
      addedAt: now,
      openedAt: now,
      status: 'processing',
      progress: 0,
      ...(fp ? { fp } : {}),
    };
    books.unshift(book);
    return { added: book };
  } catch {
    // Usually storage full. Don't leave a half-copied book behind.
    try {
      if (dir.exists) dir.delete();
    } catch {
      // recoverOrphans() tidies it next launch
    }
    return { failed: true };
  }
}

/** Save what addFile() did and start converting the new books. */
function finishAdding(added: number) {
  if (added) {
    emit();
    flushLibrary();
    void runQueue();
  } else scheduleSave(); // fingerprints filled in by findDuplicate()
}

/** Let the user pick files and add them to the shelf. */
export async function importBooks(): Promise<ImportResult> {
  const res = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true });
  if (res.canceled) return { added: 0, skipped: [], failed: [], duplicates: [] };
  const skipped: string[] = [];
  const failed: string[] = [];
  const duplicates: [string, string][] = [];
  let added = 0;
  try {
    for (const asset of res.assets) {
      const picked = new File(asset.uri);
      let name = asset.name;
      // No book extension ("document", "book.bin"): recognised from the bytes, like shared files.
      if (!isSupportedName(name)) {
        const format = sniffFile(picked);
        if (!format) {
          (format === null ? skipped : failed).push(asset.name);
          continue;
        }
        name = bookFileName(name, format);
      }
      const r = addFile(picked, name, asset.size ?? picked.size);
      if ('added' in r) added++;
      else if ('duplicate' in r) duplicates.push([asset.name, r.duplicate.title]);
      else failed.push(asset.name);
    }
  } finally {
    finishAdding(added);
  }
  return { added, skipped, failed, duplicates };
}

export type SharedFileResult =
  | { book: BookEntry; duplicate: boolean }
  /** Not a book this app reads. */
  | { unsupported: true }
  /** Couldn't be read or copied (no permission, storage full). */
  | { failed: true };

/**
 * Add a file another app handed over ("Open with" on Android). Its
 * content:// or file:// URI is only readable for a short while, so it's
 * copied right away. Shared files often come without a usable name
 * ("document", a number), so the format is recognised from the bytes.
 */
export async function importSharedFile(uri: string): Promise<SharedFileResult> {
  loadLibrary();
  const shared = new File(uri);
  // A plain file is recognised where it is, so that a huge video isn't copied
  // just to be refused. Anything from another app is copied first: reading it
  // in place can mean waiting for a download (a cloud file) with the app frozen,
  // and some apps hand over a stream whose size isn't known.
  let format = /^file:/i.test(uri) ? sniffFile(shared) : undefined;
  if (format === null) return { unsupported: true };
  // Copied under a name of our own. Copied into a folder, the file would get
  // the name the sending app reports, which could be "../../files/library.json".
  const incoming = new Directory(Paths.cache, 'incoming');
  const copy = new File(incoming, newId());
  try {
    try {
      ensureDir(incoming);
      await shared.copy(copy);
    } catch {
      return { failed: true }; // no permission to read it, or storage full
    }
    // Chat apps usually only let the file be read from start to end: recognised once copied.
    if (format === undefined) format = sniffFile(copy);
    if (format === undefined) return { failed: true };
    if (format === null) return { unsupported: true };
    const r = addFile(copy, bookFileName(sharedFileName(shared), format), copy.size);
    finishAdding('added' in r ? 1 : 0);
    if ('added' in r) return { book: r.added, duplicate: false };
    if ('duplicate' in r) return { book: r.duplicate, duplicate: true };
    return { failed: true };
  } finally {
    try {
      if (copy.exists) copy.delete();
    } catch {
      // the cache is cleared by the system anyway
    }
  }
}

/** What book a file is from its bytes: null if none, undefined if it can't be read where it is. */
function sniffFile(file: File): SniffedFormat | null | undefined {
  let src: FileSource | undefined;
  try {
    src = new FileSource(file);
    // A size of 0 can also mean "unknown" (a pipe): not readable here.
    return src.size > 0 ? sniffFormat(src) : undefined;
  } catch {
    return undefined;
  } finally {
    src?.close();
  }
}

/**
 * A name for a shared file to show as its title, from the end of its URI
 * ("My%20Book.epub"): no folders, control characters or leading dots, and
 * not endless. Many apps share a file under an id ("…/item/48213",
 * "msf:1000001234") rather than its name: then none (the book's own title,
 * or a text's first line, is used instead).
 */
function sharedFileName(file: File): string {
  let name = file.name;
  try {
    name = decodeURIComponent(name);
  } catch {
    // not percent-encoded after all
  }
  const clean = (name.split(/[/\\]/).pop() ?? '').replace(/\p{Cc}/gu, '').replace(/^[.\s]+/, '').slice(0, 120);
  return bookExtension(clean) ? clean : '';
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

// A conversion that kills the app must not be retried forever, so each one
// is counted on disk while it runs (attempts; see loadLibrary). Android also
// kills apps in the background whenever it needs memory, which says nothing
// about the book: the attempt is taken back while the app is in the
// background and counted again when it comes back.
let converting: string | null = null;
let counted = false;

function countAttempt(on: boolean) {
  const b = converting ? getBook(converting) : undefined;
  if (!b || counted === on) return;
  counted = on;
  updateBook(b.id, { attempts: Math.max(0, (b.attempts ?? 0) + (on ? 1 : -1)) });
  flushLibrary();
}

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

  converting = id;
  counted = false;
  if (AppState.currentState !== 'background') countAttempt(true);

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
        fallbackTitle: titleFromFileName(book.fileName),
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
    updateBook(id, { status: 'error', error: describeError(e), attempts: undefined });
  } finally {
    converting = null;
    src?.close();
    live.delete(id);
    emitLive();
  }
}
