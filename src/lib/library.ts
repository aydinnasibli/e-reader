// The shelf: which books exist, their reading progress, and the background
// job that converts newly imported files. A tiny observable store; screens
// subscribe with useLibrary()/useLiveBook().

import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { ingestBook, isSupportedName, titleFromFileName } from '@/engine/ingest';
import type { BookFormat, Manifest, Position } from '@/engine/types';
import {
  FileSink,
  FileSource,
  bookDir,
  booksDir,
  ensureDir,
  imageFile,
  manifestFile,
  readJson,
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

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeJson(libraryFile(), books);
  }, 400);
}

export function loadLibrary() {
  if (loaded) return;
  loaded = true;
  ensureDir(booksDir());
  books = readJson<BookEntry[]>(libraryFile()) ?? [];
  // Anything interrupted mid-conversion (app closed) starts over.
  for (const b of books) if (b.status === 'processing') b.progress = 0;
  emit();
  void runQueue();
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
  skipped: string[];
}

/** Let the user pick files and add them to the shelf. */
export async function importBooks(): Promise<ImportResult> {
  const res = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true });
  if (res.canceled) return { added: 0, skipped: [] };
  const skipped: string[] = [];
  let added = 0;
  for (const asset of res.assets) {
    if (!isSupportedName(asset.name)) {
      skipped.push(asset.name);
      continue;
    }
    const id = newId();
    const dir = bookDir(id);
    ensureDir(dir);
    const lower = asset.name.toLowerCase();
    const ext = lower.endsWith('.fb2.zip') ? 'fb2.zip' : (lower.split('.').pop() ?? 'bin');
    const dest = new File(dir, `source.${ext}`);
    const picked = new File(asset.uri);
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
    });
    added++;
  }
  emit();
  scheduleSave();
  void runQueue();
  return { added, skipped };
}

/** Convert a book again from its original file (after damage or an engine upgrade). */
export function reprocessBook(id: string) {
  updateBook(id, { status: 'processing', progress: 0, error: undefined });
  void runQueue();
}

export function deleteBook(id: string) {
  books = books.filter((b) => b.id !== id);
  live.delete(id);
  emit();
  scheduleSave();
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

  const state: LiveBook = { chunks: [], totalBlocks: 0, totalChars: 0, progress: 0 };
  live.set(id, state);
  let lastEmit = 0;
  const publish = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 250) return;
    lastEmit = now;
    live.set(id, { ...state, chunks: state.chunks.slice() });
    emitLive();
    updateBook(id, { progress: state.progress });
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
          if (info.title) patch.title = info.title;
          if (info.author) patch.author = info.author;
          if (info.coverFile) patch.coverFile = info.coverFile;
          updateBook(id, patch);
        },
      },
      book.fileName,
    );
    writeJson(manifestFile(id), manifest);
    const coverRef = manifest.cover ? manifest.images[manifest.cover] : undefined;
    updateBook(id, {
      status: 'ready',
      progress: 1,
      title: manifest.title,
      author: manifest.author,
      format: manifest.format,
      coverFile: coverRef && 'file' in coverRef ? coverRef.file : getBook(id)?.coverFile,
    });
  } catch (e) {
    updateBook(id, { status: 'error', error: e instanceof Error ? e.message : String(e) });
  } finally {
    src?.close();
    live.delete(id);
    emitLive();
  }
}
