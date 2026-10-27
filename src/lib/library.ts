// The shelf: which books exist, their reading progress, and the background
// job that converts newly imported files, and converts every book again when
// the converter changes (ENGINE_VERSION), with its highlights, bookmarks and
// place moved along (remap.ts). A tiny observable store; screens subscribe
// with useLibrary()/useLiveBook().
//
// This module is what the app imports. The parts: the shelf itself
// (libraryStore.ts), books coming in (libraryImport.ts), the background job
// (libraryQueue.ts) and putting a new conversion in place (librarySwap.ts).
// Here: starting up, and what the person does to a book.

import { Directory, File } from 'expo-file-system';
import { AppState } from 'react-native';
import { friendlyStoredError, titleFromFileName } from '@/engine/ingest';
import { normaliseLanguage } from '@/engine/language';
import { ENGINE_VERSION } from '@/engine/types';
import { forgetAnnotations } from './annotations';
import { recordCrash } from './crashLog';
import { type ImportResult, type SharedFileResult, addSharedFile, fingerprintBook, importBooks } from './libraryImport';
import { MAX_ATTEMPTS, countAttempt, queueMarks, reprocessBook, runQueue, setBookOpen, whenQueueIdle, withoutSwaps } from './libraryQueue';
import {
  type BookEntry,
  type BookStatus,
  type LiveBook,
  MISSING_SOURCE,
  bookList,
  coverUri,
  emit,
  flushLibrary,
  getBook,
  getBooks,
  isBookOpen,
  isLoaded,
  loadManifest,
  markLoaded,
  readLibraryFile,
  scheduleSave,
  setBookList,
  setLive,
  sourceExists,
  sourceFile,
  updateBook,
  useBook,
  useBookStatus,
  useLibrary,
  useLiveBook,
} from './libraryStore';
import { bookConversion, dropNext, finishSwap } from './librarySwap';
import { migrateOnce } from './migrations';
import { bookDir, booksDir, ensureDir } from './storage';

export type { BookEntry, BookStatus, ImportResult, LiveBook, SharedFileResult };
export {
  MISSING_SOURCE,
  bookConversion,
  coverUri,
  fingerprintBook,
  flushLibrary,
  getBook,
  getBooks,
  importBooks,
  isBookOpen,
  loadManifest,
  queueMarks,
  reprocessBook,
  setBookOpen,
  sourceFile,
  updateBook,
  useBook,
  useBookStatus,
  useLibrary,
  useLiveBook,
  whenQueueIdle,
  withoutSwaps,
};

export function loadLibrary() {
  if (isLoaded()) return;
  markLoaded();
  // The files brought up to date before any is read ("Open with" can get here before the root layout).
  migrateOnce();
  ensureDir(booksDir());
  setBookList(readLibraryFile());
  for (let i = 0; i < bookList().length; i++) {
    // A new conversion that was being put in place when the app closed: done
    // first, before anything reads the book. (Only books not yet on this
    // converter can have one.)
    if (bookList()[i].engine !== ENGINE_VERSION) {
      try {
        finishSwap(bookList()[i].id);
      } catch (e) {
        recordCrash('error', e);
      }
    }
    // Taken again: finishing a swap changes the entry (and the list).
    const b = bookList()[i];
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
  const known = new Set(bookList().map((b) => b.id));
  let changed = false;
  for (const d of dirs) {
    if (known.has(d.name)) continue;
    try {
      const source = d.list().find((f): f is File => f instanceof File && f.name.startsWith('source.'));
      const m = loadManifest(d.name);
      if (!source && !m) {
        d.delete();
        continue;
      }
      const now = Date.now();
      const name = source?.name ?? `source.${m!.format}`;
      bookList().push({
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

/**
 * Add a file another app handed over ("Open with" on Android, "Open in" on
 * iPhone). Its content:// or file:// URI is only readable for a short while,
 * so it's copied right away. Shared files often come without a usable name
 * ("document", a number), so the format is recognised from the bytes.
 */
export async function importSharedFile(uri: string): Promise<SharedFileResult> {
  loadLibrary();
  return addSharedFile(uri);
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

/** Go back to the title and author the book file itself gives. */
export function restoreBookTitle(id: string) {
  const m = loadManifest(id);
  const b = getBook(id);
  if (!b) return;
  updateBook(id, { title: m?.title || titleFromFileName(b.fileName), author: m?.author ?? '', titleEdited: false });
}

export function deleteBook(id: string) {
  setBookList(bookList().filter((b) => b.id !== id));
  setLive(id, undefined, true);
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
