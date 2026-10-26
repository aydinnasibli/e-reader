// The shelf: which books exist, their reading progress, and the background
// job that converts newly imported files, and converts every book again when
// the converter changes (ENGINE_VERSION), with its highlights, bookmarks and
// place moved along (remap.ts). A tiny observable store; screens subscribe
// with useLibrary()/useLiveBook().

import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { strToU8 } from 'fflate';
import { useSyncExternalStore } from 'react';
import { Alert, AppState, Platform } from 'react-native';
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
import { type BookMeta, type BookSink, CancelledError, type ChunkInfo } from '@/engine/io';
import { normaliseLanguage } from '@/engine/language';
import { type BookFormat, type ChunkFile, ENGINE_VERSION, type Manifest, type Position } from '@/engine/types';
import { type Annotations, forgetAnnotations, getAnnotations, replaceAnnotations } from './annotations';
import { recordCrash } from './crashLog';
import { fingerprintOf, hashBytes } from './fingerprint';
import { type Conversion, type MarkSet, moveMarks, movedPlace, ownMarks, withMoved } from './remap';
import { claimPending } from './restore';
import {
  FileSink,
  FileSource,
  bookDir,
  booksDir,
  ensureDir,
  imageFile,
  manifestFile,
  nextDir,
  readJson,
  removeJson,
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

/** Shown for a book whose original file an earlier version lost. */
export const MISSING_SOURCE =
  'The book’s file is missing: an earlier version of the app lost it. Add the same file again (or open it with this app again) to repair the book; its highlights, notes and place stay.';

export function loadLibrary() {
  if (loaded) return;
  loaded = true;
  ensureDir(booksDir());
  books = readJson<BookEntry[]>(libraryFile()) ?? [];
  for (let i = 0; i < books.length; i++) {
    // A new conversion that was being put in place when the app closed: done
    // first, before anything reads the book. (Only books not yet on this
    // converter can have one.)
    if (books[i].engine !== ENGINE_VERSION) {
      try {
        finishSwap(books[i].id);
      } catch (e) {
        recordCrash('error', e);
      }
    }
    const b = books[i];
    if (b.status === 'error') {
      b.error = sourceExists(b) ? friendlyStoredError(b.error) : MISSING_SOURCE;
      continue;
    }
    if (b.status === 'ready') {
      // Converting it again kept closing the app: it keeps the conversion it has.
      if ((b.attempts ?? 0) >= MAX_ATTEMPTS) {
        b.attempts = undefined;
        b.upgradeFailed = ENGINE_VERSION;
        dropNext(b.id);
      }
      continue;
    }
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
      const m = readJson<Manifest>(manifestFile(d.name));
      if (!source && !m) {
        d.delete();
        continue;
      }
      const now = Date.now();
      const name = source?.name ?? `source.${m!.format}`;
      books.push({
        id: d.name,
        title: m?.title || 'Recovered book',
        author: m?.author ?? '',
        format: m?.format,
        fileName: name,
        sourceName: name,
        size: source?.size ?? 0,
        addedAt: now,
        openedAt: 0,
        status: m ? 'ready' : 'processing',
        progress: m ? 1 : 0,
        ...(m ? { engine: m.v } : {}),
        ...(source ? {} : { sourceMissing: true }),
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

export function getBooks(): readonly BookEntry[] {
  return books;
}

/** The book file's fingerprint; worked out (and kept) for books added by older versions. */
export function fingerprintBook(b: BookEntry): string | undefined {
  if (b.fp) return b.fp;
  const fp = fingerprintFile(sourceFile(b));
  if (fp) updateBook(b.id, { fp });
  return fp;
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

function sourceExists(b: BookEntry): boolean {
  try {
    return sourceFile(b).exists;
  } catch {
    return false;
  }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export interface ImportResult {
  added: number;
  /** Not a supported format. */
  skipped: string[];
  /** Couldn't be stored: not enough free space (or another storage problem). */
  failed: string[];
  /** Couldn't be read: the app or service holding it didn't allow it, or it's gone. */
  unreadable: string[];
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
 * that is already on the shelf is dropped instead, unless that book lost its
 * own file: then this one repairs it. `file` must be the app's own copy. The
 * caller saves and starts conversion with finishAdding().
 */
function addFile(file: File, name: string, size: number): AddOutcome {
  const fp = fingerprintFile(file);
  const dup = fp ? findDuplicate(fp, size) : undefined;
  if (dup) {
    if (!sourceExists(dup) && repairSource(dup, file)) return { added: getBook(dup.id)! };
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
    // Already our own copy: moving it is instant even for huge files. A moved
    // File points at where it went (its uri changes), so a fresh one is moved
    // and the caller's still names the incoming copy.
    try {
      new File(file.uri).moveSync(dest);
    } catch {
      new File(file.uri).copySync(dest, { overwrite: true });
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
    // A restored backup may hold this book's highlights, place and collections.
    try {
      Object.assign(book, claimPending(id, book, queueMarks));
    } catch {
      // adding the book matters more; the saved data stays waiting
    }
    books.unshift(book);
    return { added: book };
  } catch (e) {
    // Usually storage full; kept in the crash log in case it's something else.
    recordCrash('error', e);
    // Don't leave a half-copied book behind.
    try {
      if (dir.exists) dir.delete();
    } catch {
      // recoverOrphans() tidies it next launch
    }
    return { failed: true };
  }
}

/**
 * A book whose original file was lost gets this copy of it: its pictures
 * show again, and it is converted again (with its marks) if it needs to be.
 */
function repairSource(book: BookEntry, file: File): boolean {
  try {
    ensureDir(bookDir(book.id));
    new File(file.uri).moveSync(sourceFile(book));
  } catch {
    return false;
  }
  const failed = book.status === 'error';
  updateBook(book.id, {
    sourceMissing: undefined,
    upgradeFailed: undefined,
    ...(failed ? { status: 'processing', progress: 0, error: undefined, attempts: 0 } : {}),
  });
  return true;
}

/** Save what addFile() did and start converting the new books. */
function finishAdding(added: number) {
  if (added) {
    emit();
    flushLibrary();
    void runQueue();
  } else scheduleSave(); // fingerprints filled in by findDuplicate()
}

/** Free space on the phone, in bytes (Infinity when it can't be told). */
function freeSpace(): number {
  try {
    const n = Paths.availableDiskSpace;
    return typeof n === 'number' && Number.isFinite(n) ? n : Infinity;
  } catch {
    return Infinity;
  }
}

/** Room left free when a book is copied in: converting it needs some too. */
const SPARE_BYTES = 20 * 1024 * 1024;
const NO_SPACE = /ENOSPC|no space|not enough (free )?space|disk full|storage full/i;

type Incoming = AddOutcome | { unsupported: true } | { unreadable: true } | { noSpace: true };

/**
 * Copy a file from elsewhere (picked, or handed over by another app) into the
 * app with the asynchronous file API, recognise it and put it on the shelf.
 * `name`: the picker's name for it; a shared file's name comes from its URI,
 * and it is always recognised from its bytes (the name could be anything).
 */
async function addIncoming(src: File, opts: { name: string; size?: number; shared: boolean }): Promise<Incoming> {
  const trustName = !opts.shared && isSupportedName(opts.name);
  let format: SniffedFormat | null | undefined;
  // A plain file is recognised where it is, so that a huge video isn't
  // copied just to be refused. Anything from another app is copied first:
  // reading it in place can mean waiting for a download (a cloud file) with
  // the app frozen, and some apps hand over a stream whose size isn't known.
  if (!trustName && /^file:/i.test(src.uri)) {
    format = sniffFile(src);
    if (format === null) return { unsupported: true };
  }
  const size = opts.size || 0;
  if (size && freeSpace() < size + SPARE_BYTES) return { noSpace: true };
  // Copied under a name of our own. Copied into a folder, the file would get
  // the name the sending app reports, which could be "../../files/library.json".
  const incoming = new Directory(Paths.cache, 'incoming');
  const copy = new File(incoming, newId());
  const at = copy.uri;
  try {
    try {
      ensureDir(incoming);
      await src.copy(copy);
      // Some apps hand over a pipe, which Android copies as an empty file
      // (it sizes the copy by the channel, 0 for a pipe): read it through instead.
      if (!copy.size) {
        const bytes = await src.bytes();
        if (bytes.length) await copy.write(bytes);
      }
    } catch (e) {
      return NO_SPACE.test(String(e)) || (size > 0 && freeSpace() < size) ? { noSpace: true } : { unreadable: true };
    }
    if (!copy.size) return { unsupported: true }; // an empty file
    // Chat apps usually only let the file be read from start to end: recognised once copied.
    if (format === undefined && !trustName) format = sniffFile(copy);
    if (format === null) return { unsupported: true };
    if (format === undefined && !trustName) return { unreadable: true };
    const name = trustName || !format ? opts.name : bookFileName(opts.shared ? sharedFileName(src) : opts.name, format);
    const r = addFile(copy, name, copy.size);
    return 'failed' in r && freeSpace() < copy.size + SPARE_BYTES ? { noSpace: true } : r;
  } finally {
    try {
      const left = new File(at);
      if (left.exists) left.delete();
    } catch {
      // the cache is cleared by the system anyway
    }
  }
}

/** Let the user pick files and add them to the shelf. */
export async function importBooks(): Promise<ImportResult> {
  // The picker isn't asked for its own copy: Android makes it on the UI
  // thread (the app freezes for a big book), and in Expo Go the copy lands
  // where the app may not read it. Each file is copied in by addIncoming().
  const res = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: false });
  const result: ImportResult = { added: 0, skipped: [], failed: [], unreadable: [], duplicates: [] };
  if (res.canceled) return result;
  try {
    for (const asset of res.assets) {
      const r = await addIncoming(new File(asset.uri), { name: asset.name, size: asset.size ?? undefined, shared: false });
      if ('added' in r) {
        result.added++;
        finishAdding(1);
      } else if ('duplicate' in r) result.duplicates.push([asset.name, r.duplicate.title]);
      else if ('unsupported' in r) result.skipped.push(asset.name);
      else if ('unreadable' in r) result.unreadable.push(asset.name);
      else result.failed.push(asset.name);
      dropPickedCopy(asset.uri);
    }
  } finally {
    if (!result.added) finishAdding(0);
  }
  return result;
}

/** iOS hands the picked file over as the app's own temporary copy: not kept once added. */
function dropPickedCopy(uri: string) {
  if (Platform.OS !== 'ios' || !/^file:.*\/tmp\//i.test(uri)) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // iOS clears the app's temporary files itself
  }
}

export type SharedFileResult =
  | { book: BookEntry; duplicate: boolean }
  /** Not a book this app reads. */
  | { unsupported: true }
  /** Couldn't be read (no permission, gone), or there's no room for it. */
  | { failed: 'unreadable' | 'space' };

/**
 * Add a file another app handed over ("Open with" on Android, "Open in" on
 * iPhone). Its content:// or file:// URI is only readable for a short while,
 * so it's copied right away. Shared files often come without a usable name
 * ("document", a number), so the format is recognised from the bytes.
 */
export async function importSharedFile(uri: string): Promise<SharedFileResult> {
  loadLibrary();
  const r = await addIncoming(new File(uri), { name: '', shared: true });
  finishAdding('added' in r ? 1 : 0);
  if ('added' in r) return { book: r.added, duplicate: false };
  if ('duplicate' in r) return { book: r.duplicate, duplicate: true };
  if ('unsupported' in r) return { unsupported: true };
  return { failed: 'unreadable' in r ? 'unreadable' : 'space' };
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

/** Set the book's language by hand (Book details); undefined goes back to the book's own or guessed one. */
export function setBookLanguage(id: string, lang?: string) {
  updateBook(id, { lang: normaliseLanguage(lang) });
}

/** Books open in the reader now: a book converted again is swapped in only once it's closed. */
const openBooks = new Map<string, number>();

/** The reader opened (true) or closed (false) a book. */
export function setBookOpen(id: string, open: boolean) {
  const n = (openBooks.get(id) ?? 0) + (open ? 1 : -1);
  if (n > 0) openBooks.set(id, n);
  else {
    openBooks.delete(id);
    // Its new conversion, or a backup's marks, may be waiting for it to be closed.
    skipped.delete(id);
    if (!open && loaded) void runQueue();
  }
}

export function isBookOpen(id: string): boolean {
  return openBooks.has(id);
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

// ---------- marks waiting for a conversion ----------

const marksFile = (id: string) => new File(bookDir(id), 'marks.json');

function waitingMarks(id: string): MarkSet[] {
  const saved = readJson<MarkSet[]>(marksFile(id));
  return Array.isArray(saved) ? saved.map((set, i) => (set.key ? set : { ...set, key: `set${i}` })) : [];
}

/**
 * Keep marks to be put on the book's conversion once it is ready, found by
 * their text: a backup's made on another conversion (restore.ts), or the
 * book's own before it is converted again. Throws if they can't be saved.
 */
export function queueMarks(id: string, set: MarkSet) {
  writeJson(marksFile(id), [...waitingMarks(id), { ...set, key: set.key ?? newId() }]);
  updateBook(id, { marksWaiting: true });
  flushLibrary();
  if (getBook(id)?.status === 'ready') void runQueue();
}

/**
 * Put the waiting marks on the book's conversion. Each set leaves marks.json
 * once placed, and sets queued meanwhile are placed too. A backup's marks
 * wait while the book is open: the reader saves where it is when it's
 * closed, which would take the place of the backup's. Returns whether none
 * are left (false: the book is open, or its conversion can't be read).
 */
async function placeWaitingMarks(id: string, pause: () => Promise<void>): Promise<boolean> {
  const m = loadManifest(id);
  const placed = new Set<string>();
  for (;;) {
    const sets = waitingMarks(id).filter((set) => !placed.has(set.key!) && !(set.merge && isBookOpen(id)));
    if (!sets.length || !m) break;
    const conv = conversionAt(bookDir(id), m);
    for (const set of sets) {
      const moved = await moveMarks(set, conv, { toc: m.toc, pause });
      const book = getBook(id);
      if (!book) return true;
      replaceAnnotations(id, withMoved(getAnnotations(id), set, moved));
      const place = movedPlace(book, set, moved);
      if (place) updateBook(id, place);
      placed.add(set.key!);
      // Off the list; whatever was queued meanwhile stays.
      const rest = waitingMarks(id).filter((x) => x.key !== set.key);
      if (rest.length) writeJson(marksFile(id), rest);
      else removeJson(marksFile(id));
    }
  }
  const left = waitingMarks(id).length > 0;
  updateBook(id, { marksWaiting: left || undefined });
  return !left;
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

/** Run a book's conversion job, counted as an attempt while it runs. */
async function attempt(id: string, job: () => Promise<void>) {
  converting = id;
  counted = false;
  if (AppState.currentState !== 'background') countAttempt(true);
  try {
    await job();
  } finally {
    converting = null;
    // Finished, failed or given up: not a crash.
    if (getBook(id)?.attempts !== undefined) updateBook(id, { attempts: undefined });
  }
}

/** Books whose conversion in next/ waits for them to be closed, or gave up this time round. */
let skipped = new Set<string>();
/** Titles of books found without their original file, to say so once. */
const missing: string[] = [];

async function runQueue() {
  if (running) return;
  running = true;
  skipped = new Set();
  try {
    for (;;) {
      // New books first, then marks waiting for a ready book, then books converted again.
      const next = books.find((b) => b.status === 'processing');
      if (next) {
        try {
          await attempt(next.id, () => convert(next));
        } catch (e) {
          // Not the book's fault as far as anyone can tell, but it mustn't be tried forever.
          recordCrash('error', e);
          updateBook(next.id, { status: 'error', error: describeError(e) });
        }
        continue;
      }
      const marked = books.find((b) => b.status === 'ready' && b.marksWaiting && !skipped.has(b.id));
      if (marked) {
        try {
          // Open (a backup's marks wait until it's closed), or its conversion can't be read (until "Try again").
          if (!(await placeWaitingMarks(marked.id, makePause(marked.id)))) skipped.add(marked.id);
        } catch (e) {
          // Given way to a new book: back to it after that.
          if (e instanceof CancelledError) continue;
          recordCrash('error', e);
          skipped.add(marked.id);
        }
        continue;
      }
      const old = toUpgrade();
      if (!old) break;
      try {
        await attempt(old.id, () => upgrade(old));
      } catch (e) {
        recordCrash('error', e);
        skipped.add(old.id);
      }
    }
  } finally {
    running = false;
  }
  noteMissingSources();
}

/**
 * Yield to the UI whenever we've worked for a few milliseconds. Background
 * work on book `id` gives way (CancelledError) when a new book waits to be
 * converted, or the book is removed.
 */
function makePause(id?: string) {
  let last = Date.now();
  return async () => {
    if (id && (!getBook(id) || books.some((b) => b.status === 'processing'))) throw new CancelledError();
    if (Date.now() - last < 12) return;
    await new Promise((r) => setTimeout(r, 1));
    last = Date.now();
  };
}

/** Read access to a book's conversion (for finding its marks by their text), if it has one. */
export function bookConversion(id: string, m: Manifest | null = loadManifest(id)): Conversion | null {
  return m ? conversionAt(bookDir(id), m) : null;
}

/** Read access to a conversion in `root` (a book's folder or its next/). */
function conversionAt(root: Directory, m: Manifest): Conversion {
  return {
    chunks: m.chunks,
    totalBlocks: m.totalBlocks,
    totalChars: m.totalChars,
    read: async (i) => (JSON.parse(await new File(root, 'c', `${i}.json`).text()) as ChunkFile).b,
  };
}

/** The reader's page numbers for a book (reader-owned), with the copies writeJson keeps. */
const pageFiles = (id: string) => ['pages.json', 'pages.json.bak', 'pages.json.tmp'].map((n) => new File(bookDir(id), n));

/** Remove a book's conversion (and what belongs to it) before converting it again in place. */
function clearConversion(id: string) {
  const dir = bookDir(id);
  for (const d of [new Directory(dir, 'c'), new Directory(dir, 'img'), nextDir(id)]) {
    try {
      if (d.exists) d.delete();
    } catch {
      // ignore
    }
  }
  for (const f of [manifestFile(id), new File(dir, 'manifest.json.bak'), new File(dir, 'manifest.json.tmp'), ...pageFiles(id)]) {
    try {
      if (f.exists) f.delete();
    } catch {
      // ignore
    }
  }
}

/**
 * Convert a book's original file into `root`. Returns the manifest, saved
 * there last (so a manifest means the conversion is complete). `whole`: a
 * picture that can't be written (the converter goes on without it, which
 * suits a first conversion) fails it instead, so that converting a book
 * again never puts a conversion missing pictures in place of a whole one.
 */
async function ingestInto(
  book: BookEntry,
  root: Directory,
  opts: {
    onChunk?: (index: number, info: ChunkInfo) => void;
    progress?: (f: number) => void;
    meta?: (info: BookMeta) => void;
    pause: () => Promise<void>;
    whole?: boolean;
  },
): Promise<Manifest> {
  let src: FileSource | null = null;
  let lost: unknown = null;
  try {
    src = new FileSource(sourceFile(book));
    const files = new FileSink(book.id, opts.onChunk, root);
    const picture = (write: () => void) => {
      try {
        write();
      } catch (e) {
        lost ??= e;
        throw e;
      }
    };
    const sink: BookSink = {
      writeChunk: (index, json, info) => files.writeChunk(index, json, info),
      writeImage: (name, data) => picture(() => files.writeImage(name, data)),
      writeImageBase64: (name, base64) => picture(() => files.writeImageBase64(name, base64)),
    };
    const manifest = await ingestBook(
      { src, sink, progress: opts.progress ?? (() => {}), pause: opts.pause, fallbackTitle: titleFromFileName(book.fileName), meta: opts.meta },
      book.fileName,
    );
    if (opts.whole && lost) throw lost;
    writeJson(new File(root, 'manifest.json'), manifest);
    return manifest;
  } finally {
    src?.close();
  }
}

/** First conversion of a book, or "Try again": converted in place, readable as it goes. */
async function convert(book: BookEntry) {
  const id = book.id;
  // Without its file nothing can be converted: what it has stays.
  if (!sourceExists(book)) {
    const readable = !!loadManifest(id);
    updateBook(id, readable ? { status: 'ready', progress: 1, sourceMissing: true, error: undefined } : { status: 'error', error: MISSING_SOURCE, sourceMissing: true });
    flushLibrary();
    if (readable) noteMissingSources([book.title]);
    return;
  }
  // Converted before ("Try again"): its marks are kept with their text first, to find them again once it's done.
  try {
    await keepOwnMarks(id);
  } catch (e) {
    if (!getBook(id)) return;
    // Its old conversion and marks stay as they are.
    updateBook(id, { status: 'error', error: describeError(e) });
    return;
  }
  clearConversion(id);

  const state: LiveBook = { chunks: [], totalBlocks: 0, totalChars: 0, progress: 0 };
  live.set(id, state);
  let lastEmit = 0;
  // Progress goes to the live store only: it changes many times a second and
  // isn't worth saving (an interrupted conversion starts over anyway).
  const publish = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 250) return;
    lastEmit = now;
    live.set(id, {
      ...state,
      chunks: state.chunks.slice(),
      ...(state.weights ? { weights: state.weights.slice() } : {}),
      ...(state.opens ? { opens: state.opens.slice() } : {}),
    });
    emitLive();
  };

  try {
    const manifest = await ingestInto(book, bookDir(id), {
      onChunk: (index, info) => {
        state.chunks[index] = [info.firstBlock, info.firstChar];
        if (info.weight !== undefined) (state.weights ??= [])[index] = info.weight;
        if (info.opens) (state.opens ??= []).push(index);
        state.totalBlocks = info.firstBlock + info.blocks;
        state.totalChars = info.firstChar + info.chars;
        // The very first chunk is published right away so the book can be opened.
        publish(index === 0);
      },
      progress: (f) => {
        state.progress = f;
        publish();
      },
      pause: makePause(),
      meta: (info) => {
        const patch: Partial<BookEntry> = {};
        const edited = getBook(id)?.titleEdited;
        if (info.title && !edited) patch.title = info.title;
        if (info.author && !edited) patch.author = info.author;
        if (info.coverFile) patch.coverFile = info.coverFile;
        updateBook(id, patch);
      },
    });
    // Marks kept from before, or a backup's (claimed when the book was
    // added, before it was listed), find their places before the book counts
    // as ready: it is never shown with marks on the wrong words.
    if (getBook(id)?.marksWaiting || marksFile(id).exists) {
      try {
        await placeWaitingMarks(id, makePause());
      } catch (e) {
        recordCrash('error', e);
      }
    }
    const coverRef = manifest.cover ? manifest.images[manifest.cover] : undefined;
    const edited = getBook(id)?.titleEdited;
    updateBook(id, {
      status: 'ready',
      progress: 1,
      attempts: undefined,
      engine: manifest.v,
      upgradeFailed: undefined,
      sourceMissing: undefined,
      ...(edited ? {} : { title: manifest.title, author: manifest.author }),
      format: manifest.format,
      coverFile: coverRef && 'file' in coverRef ? coverRef.file : getBook(id)?.coverFile,
    });
  } catch (e) {
    updateBook(id, { status: 'error', error: describeError(e), attempts: undefined });
    return;
  } finally {
    live.delete(id);
    emitLive();
  }
}

/**
 * Before a book that was converted before is converted again in place ("Try
 * again"): its marks, anchored by their text on the old conversion (as far as
 * it can still be read), wait in marks.json, and a copy of its annotations is
 * kept. Done once: after a restart the old conversion may be gone.
 */
async function keepOwnMarks(id: string) {
  const book = getBook(id);
  const old = loadManifest(id);
  if (!book || !old || waitingMarks(id).some((s) => !s.merge)) return;
  const ann = getAnnotations(id);
  if (!ann.highlights.length && !ann.bookmarks.length && !book.position) return;
  keepAnnotations(id, old.v);
  queueMarks(id, await ownMarks(conversionAt(bookDir(id), old), ann, book.position, book.percent, makePause()));
}

/**
 * Keep a copy of a book's annotations as they are, just before they are
 * moved off conversion version `v` (annotations.v1.json).
 */
function keepAnnotations(id: string, v: number | undefined) {
  try {
    const ann = new File(bookDir(id), 'annotations.json');
    if (ann.exists) ann.copySync(new File(bookDir(id), `annotations.v${v ?? 1}.json`), { overwrite: true });
  } catch {
    // the copy is a precaution; the marks themselves move on
  }
}

/** The next book to convert again with this converter (most recently read first), if any. */
function toUpgrade(): BookEntry | undefined {
  for (const b of [...books].sort((x, y) => y.openedAt - x.openedAt)) {
    if (b.status !== 'ready' || skipped.has(b.id) || b.upgradeFailed === ENGINE_VERSION) continue;
    let v = b.engine;
    if (v === undefined) {
      // Converted by a version that didn't note it: its manifest says (none: damaged, so converted again).
      v = loadManifest(b.id)?.v ?? 0;
      updateBook(b.id, { engine: v });
    }
    if (v >= ENGINE_VERSION) continue;
    if (!sourceExists(b)) {
      if (!b.sourceMissing) {
        // Said once (noteMissingSources), so noted on disk at once.
        updateBook(b.id, { sourceMissing: true });
        flushLibrary();
        missing.push(b.title);
      }
      continue;
    }
    // Its new conversion is ready and waits for the book to be closed (or a backup to finish).
    if ((isBookOpen(b.id) || swapsHeld > 0) && finishedNext(b.id)) continue;
    return b;
  }
  return undefined;
}

/** The conversion in next/, if one by this converter is complete there (its manifest is written last). */
function finishedNext(id: string): Manifest | null {
  const m = readJson<Manifest>(new File(nextDir(id), 'manifest.json'));
  return m && m.v === ENGINE_VERSION && Array.isArray(m.chunks) ? m : null;
}

function dropNext(id: string) {
  try {
    const d = nextDir(id);
    if (d.exists) d.delete();
  } catch {
    // tried again next time
  }
}

/**
 * Convert a ready book again with this converter, into next/ while it is
 * read as it was, then swap it in with its marks moved (once it isn't open).
 * A conversion complete in next/ from before the app was closed is used as
 * it is.
 */
async function upgrade(book: BookEntry) {
  const id = book.id;
  const pause = makePause(id);
  let m = finishedNext(id);
  if (!m) {
    dropNext(id);
    // Room for a second conversion of it beside the first, or not now.
    if (freeSpace() < conversionSize(id) + SPARE_BYTES) {
      skipped.add(id);
      return;
    }
    try {
      m = await ingestInto(book, nextDir(id), { pause, whole: true });
    } catch (e) {
      dropNext(id);
      // A new book to convert first, or the book was removed: back to it later, or never.
      if (e instanceof CancelledError || !getBook(id)) return;
      // The phone is full: not the book's fault, tried again another time.
      if (NO_SPACE.test(String(e))) {
        skipped.add(id);
        return;
      }
      // It keeps the conversion it has; not tried again until a newer converter.
      updateBook(id, { upgradeFailed: ENGINE_VERSION });
      recordCrash('error', e);
      return;
    }
  }
  try {
    // Open: swapped in once it's closed (toUpgrade() passes it over until then).
    if ((await swapIn(id, m, pause)) === 'busy') skipped.add(id);
  } catch (e) {
    if (e instanceof CancelledError) return;
    skipped.add(id);
    // The moved marks couldn't be saved: the space the new conversion takes is given back.
    if (NO_SPACE.test(String(e))) dropNext(id);
    else recordCrash('error', e);
  }
}

/** Bytes a book's conversion takes (its chunks and pictures). */
function conversionSize(id: string): number {
  let n = 0;
  for (const sub of ['c', 'img']) {
    try {
      n += new Directory(bookDir(id), sub).size ?? 0;
    } catch {
      // not there
    }
  }
  return n;
}

/** Backups running: no new conversion is swapped in meanwhile. */
let swapsHeld = 0;

/**
 * Run `job` with no book's new conversion swapped in meanwhile: a backup
 * reads each book's marks and the conversion they belong to, which must not
 * change half way.
 */
export async function withoutSwaps<T>(job: () => Promise<T>): Promise<T> {
  swapsHeld++;
  try {
    return await job();
  } finally {
    swapsHeld--;
    if (!swapsHeld && loaded) void runQueue();
  }
}

/** What finishSwap() does, saved before it starts so that it can be finished after a restart. */
interface SwapPlan {
  /** Converter versions of the conversion replaced and of the one taking over. */
  from?: number;
  to: number;
  annotations: Annotations;
  patch: Partial<BookEntry>;
  /** The marks (marksKey) and reading place the plan was made from, and the marks it makes. */
  basis: string;
  place?: Position;
  result: string;
}

const planFile = (id: string) => new File(nextDir(id), 'commit.json');
const dropPlan = (id: string) => removeJson(planFile(id));

/** A book's marks as one value, to tell whether they are still what a plan was made from. */
function marksKey(a: Annotations): string {
  const lines = (list: object[]) =>
    list
      .map((x) => JSON.stringify(x, Object.keys(x).sort()))
      .sort()
      .join('\n');
  return hashBytes(strToU8(`${lines(a.highlights)}\n--\n${lines(a.bookmarks)}`));
}

const samePosition = (a?: Position, b?: Position) => (!a && !b) || (!!a && !!b && a.b === b.b && a.o === b.o);

/**
 * Put a book's new conversion (complete in next/) in place of its old one,
 * its marks moved along. Marks are found on both conversions in the
 * background; the swap itself is done in one go after checking that nothing
 * changed meanwhile. Not while the book is open ('open': once it's closed).
 */
async function swapIn(id: string, m: Manifest, pause: () => Promise<void>): Promise<'done' | 'open' | 'busy'> {
  const fresh = conversionAt(nextDir(id), m);
  for (let tries = 0; tries < 3; tries++) {
    const book = getBook(id);
    if (!book) return 'done';
    if (isBookOpen(id) || swapsHeld) return 'open';
    const ann = getAnnotations(id);
    const old = loadManifest(id);
    const set = await ownMarks(old ? conversionAt(bookDir(id), old) : null, ann, book.position, book.percent, pause);
    const moved = await moveMarks(set, fresh, { toc: m.toc, pause });
    const now = getBook(id);
    if (!now) return 'done';
    if (isBookOpen(id) || swapsHeld) return 'open';
    // A note edited or the place saved meanwhile: found again with the change.
    if (getAnnotations(id) !== ann || now.position !== book.position) continue;
    const place = movedPlace(now, set, moved);
    const cover = m.cover ? m.images[m.cover] : undefined;
    const annotations = withMoved(ann, set, moved);
    const plan: SwapPlan = {
      from: old?.v ?? now.engine,
      to: m.v,
      annotations,
      patch: {
        ...(place ? { position: place.position, percent: place.percent } : {}),
        ...(now.titleEdited ? {} : { title: m.title, author: m.author }),
        format: m.format,
        coverFile: cover && 'file' in cover ? cover.file : undefined,
        upgradeFailed: undefined,
      },
      basis: marksKey(ann),
      ...(now.position ? { place: now.position } : {}),
      result: marksKey(annotations),
    };
    // The manifest is complete (it may still be the .tmp of a save cut short): in place under its name.
    const nm = new File(nextDir(id), 'manifest.json');
    if (!nm.exists) writeJson(nm, m);
    writeJson(planFile(id), plan);
    if (finishSwap(id)) return 'done';
  }
  // Its marks keep changing (edited in Highlights & notes): another time.
  return 'busy';
}

/**
 * Carry out a swap planned in next/commit.json. Every step can run again: the
 * app may close at any point, and this runs again at the next start before
 * anything reads the book. Once the library says the book has the new
 * conversion, the rest was done before, so a plan is never carried out twice;
 * and it is only carried out on the marks and place it was made from (or
 * once its marks are saved): a plan that couldn't be carried out, followed
 * by more reading and new marks, is dropped and made again from those.
 * False: there was no plan to carry out.
 */
function finishSwap(id: string): boolean {
  const plan = readJson<SwapPlan>(planFile(id));
  if (!plan) return false;
  const book = getBook(id);
  if (book && book.engine !== plan.to) {
    const dir = bookDir(id);
    const next = nextDir(id);
    const marks = marksKey(getAnnotations(id));
    // Saved before the app closed: the rest follows.
    const saved = marks === plan.result;
    if (!saved && (marks !== plan.basis || !samePosition(book.position, plan.place))) {
      dropPlan(id);
      return false;
    }
    if (!saved) {
      keepAnnotations(id, plan.from);
      try {
        // The moved marks first: if they can't be saved (the phone is full),
        // nothing else has changed, and the plan is made again another time.
        replaceAnnotations(id, plan.annotations);
      } catch (e) {
        dropPlan(id);
        throw e;
      }
    }
    for (const name of ['c', 'img']) {
      const fresh = new Directory(next, name);
      if (!fresh.exists) continue;
      const old = new Directory(dir, name);
      if (old.exists) old.delete();
      fresh.moveSync(old);
    }
    const nm = new File(next, 'manifest.json');
    if (nm.exists) {
      // The old manifest's saved copies must not be read for the new chunks.
      for (const n of ['manifest.json.bak', 'manifest.json.tmp']) {
        const f = new File(dir, n);
        if (f.exists) f.delete();
      }
      nm.moveSync(manifestFile(id), { overwrite: true });
    }
    for (const f of pageFiles(id)) if (f.exists) f.delete();
    updateBook(id, { ...plan.patch, engine: plan.to });
    flushLibrary();
  }
  // Done: the plan goes first (with its saved copies), so it can't be carried out again.
  dropPlan(id);
  dropNext(id);
  return true;
}

/** Tell once about books found without their original file. */
function noteMissingSources(titles: string[] = []) {
  const list = [...missing.splice(0), ...titles];
  if (!list.length) return;
  Alert.alert(
    list.length === 1 ? 'A book needs its file again' : 'Some books need their files again',
    `An earlier version of the app lost the original ${list.length === 1 ? 'file of this book' : 'files of these books'} when ${list.length === 1 ? 'it was' : 'they were'} opened from another app. ${list.length === 1 ? 'It' : 'They'} can still be read, but pictures in ${list.length === 1 ? 'it' : 'them'} can’t be shown and ${list.length === 1 ? 'it doesn’t' : 'they don’t'} get this update’s improvements. To repair one, add its file again (or open it with this app again): its highlights, notes and place stay.\n\n${list.join('\n')}`,
  );
}
