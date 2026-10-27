// The background job: converts newly imported books, puts marks waiting in
// marks.json onto their book's conversion, and converts every book again
// when the converter changes (ENGINE_VERSION), the new conversion swapped in
// with its marks (librarySwap.ts). One book at a time, giving way to the UI.

import { Directory, File } from 'expo-file-system';
import { AppState } from 'react-native';
import { describeError, ingestBook, titleFromFileName } from '@/engine/ingest';
import { type BookMeta, type BookSink, CancelledError, type ChunkInfo } from '@/engine/io';
import { ENGINE_VERSION, type Manifest } from '@/engine/types';
import { getAnnotations, replaceAnnotations } from './annotations';
import { recordCrash } from './crashLog';
import { isRecord } from './guards';
import { newId } from './ids';
import {
  type BookEntry,
  type LiveBook,
  MISSING_SOURCE,
  bookList,
  countOpen,
  flushLibrary,
  getBook,
  holdSwaps,
  isBookOpen,
  isLoaded,
  loadManifest,
  setLive,
  sourceExists,
  sourceFile,
  swapsAreHeld,
  updateBook,
} from './libraryStore';
import { conversionAt, dropNext, finishedNext, keepAnnotations, pagesFile, swapIn } from './librarySwap';
import { notice } from './notices';
import { type MarkSet, moveMarks, movedPlace, ownMarks, withMoved } from './remap';
import { freeSpace, isNoSpace } from './space';
import { FileSink, FileSource, bookDir, manifestFile, nextDir, readJson, removeJson, writeJson } from './storage';

/** Conversions started and not finished before a book stops being tried (see loadLibrary). */
export const MAX_ATTEMPTS = 2;
/** Room left free when a book is copied in or converted again: converting it needs some too. */
export const SPARE_BYTES = 20 * 1024 * 1024;

// ---------- marks waiting for a conversion ----------

const marksFile = (id: string) => new File(bookDir(id), 'marks.json');

function waitingMarks(id: string): MarkSet[] {
  const saved = readJson<unknown[]>(marksFile(id), Array.isArray);
  return (saved ?? []).filter(isRecord).map((set, i) => (set.key ? set : { ...set, key: `set${i}` }) as unknown as MarkSet);
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

/** Marks waiting for this book (claimed from a backup when it was added, say). */
export const hasWaitingMarks = (id: string) => marksFile(id).exists;

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
/** Settles when the queue has nothing left to do for now (see whenQueueIdle). */
let idle: { promise: Promise<void>; resolve: () => void } | null = null;

// A conversion that kills the app must not be retried forever, so each one
// is counted on disk while it runs (attempts; see loadLibrary). Android also
// kills apps in the background whenever it needs memory, which says nothing
// about the book: the attempt is taken back while the app is in the
// background and counted again when it comes back.
let converting: string | null = null;
let counted = false;

/** The app came to the front (true) or went to the background (false): the running conversion's attempt counts, or doesn't. */
export function countAttempt(on: boolean) {
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

/** Work through what there is to do: new books, waiting marks, books to convert again. */
export async function runQueue() {
  if (running) return;
  running = true;
  if (!idle) {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((r) => {
      resolve = () => r();
    });
    idle = { promise, resolve };
  }
  skipped = new Set();
  try {
    for (;;) {
      // New books first, then marks waiting for a ready book, then books converted again.
      const next = bookList().find((b) => b.status === 'processing');
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
      const marked = bookList().find((b) => b.status === 'ready' && b.marksWaiting && !skipped.has(b.id));
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
    // Said before anyone waiting for the queue hears it's done (it never throws).
    noteMissingSources();
    const done = idle;
    idle = null;
    done?.resolve();
  }
}

/** Resolves once the background job has nothing left to do for now (at once if it isn't running). */
export function whenQueueIdle(): Promise<void> {
  return idle?.promise ?? Promise.resolve();
}

/**
 * Yield to the UI whenever we've worked for a few milliseconds. Background
 * work on book `id` gives way (CancelledError) when a new book waits to be
 * converted, or the book is removed.
 */
function makePause(id?: string) {
  let last = Date.now();
  return async () => {
    if (id && (!getBook(id) || bookList().some((b) => b.status === 'processing'))) throw new CancelledError();
    if (Date.now() - last < 12) return;
    await new Promise((r) => setTimeout(r, 1));
    last = Date.now();
  };
}

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
  removeJson(manifestFile(id));
  removeJson(pagesFile(id));
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
  setLive(id, state, true);
  let lastEmit = 0;
  // Progress goes to the live store only: it changes many times a second and
  // isn't worth saving (an interrupted conversion starts over anyway).
  const publish = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 250) return;
    lastEmit = now;
    setLive(id, {
      ...state,
      chunks: state.chunks.slice(),
      ...(state.weights ? { weights: state.weights.slice() } : {}),
      ...(state.opens ? { opens: state.opens.slice() } : {}),
    });
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
    if (getBook(id)?.marksWaiting || hasWaitingMarks(id)) {
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
    setLive(id, undefined);
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

/** The next book to convert again with this converter (most recently read first), if any. */
function toUpgrade(): BookEntry | undefined {
  for (const b of [...bookList()].sort((x, y) => y.openedAt - x.openedAt)) {
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
    if ((isBookOpen(b.id) || swapsAreHeld()) && finishedNext(b.id)) continue;
    return b;
  }
  return undefined;
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
      if (isNoSpace(e)) {
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
    if (isNoSpace(e)) dropNext(id);
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

/**
 * Run `job` with no book's new conversion swapped in meanwhile: a backup
 * reads each book's marks and the conversion they belong to, which must not
 * change half way.
 */
export async function withoutSwaps<T>(job: () => Promise<T>): Promise<T> {
  holdSwaps(1);
  try {
    return await job();
  } finally {
    if (!holdSwaps(-1) && isLoaded()) void runQueue();
  }
}

/** The reader opened (true) or closed (false) a book. */
export function setBookOpen(id: string, open: boolean) {
  if (countOpen(id, open)) return;
  // Its new conversion, or a backup's marks, may be waiting for it to be closed.
  skipped.delete(id);
  if (!open && isLoaded()) void runQueue();
}

/** Convert a book again from its original file (after damage or an engine upgrade). */
export function reprocessBook(id: string) {
  updateBook(id, { status: 'processing', progress: 0, error: undefined, attempts: 0 });
  void runQueue();
}

/** Tell once about books found without their original file. */
export function noteMissingSources(titles: string[] = []) {
  const list = [...missing.splice(0), ...titles];
  if (!list.length) return;
  notice(
    list.length === 1 ? 'A book needs its file again' : 'Some books need their files again',
    `An earlier version of the app lost the original ${list.length === 1 ? 'file of this book' : 'files of these books'} when ${list.length === 1 ? 'it was' : 'they were'} opened from another app. ${list.length === 1 ? 'It' : 'They'} can still be read, but pictures in ${list.length === 1 ? 'it' : 'them'} can’t be shown and ${list.length === 1 ? 'it doesn’t' : 'they don’t'} get this update’s improvements. To repair one, add its file again (or open it with this app again): its highlights, notes and place stay.\n\n${list.join('\n')}`,
  );
}
