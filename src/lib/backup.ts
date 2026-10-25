// A backup of what the person made in the app, as one JSON file to keep
// anywhere (Files, a drive, a message to oneself) and restore on any phone,
// Android or iPhone: highlights, notes and bookmarks, reading places,
// finished marks, edited titles, collections, reading stats and settings.
// Not the books: a book's data waits until the same file is added again
// (restore.ts).

import Constants from 'expo-constants';
import { File } from 'expo-file-system';
import type { Position } from '@/engine/types';
import { HIGHLIGHT_COLORS } from '@/ui/theme';
import { type Annotations, type Bookmark, type Highlight, getAnnotations } from './annotations';
import { SORT_LABELS, type SortKey, type ViewMode, collectionNamed, getShelves, setSort, setView } from './collections';
import { fingerprintBook, flushLibrary, getBooks, loadManifest, updateBook } from './library';
import { type SavedBook, addPending, applySaved } from './restore';
import { getSettings, sanitizeSettings, setSettings } from './settings';
import { type BookStats, getStats, mergeDays } from './stats';

export const BACKUP_KIND = 'nec-reader-backup';

export interface Backup {
  kind: typeof BACKUP_KIND;
  version: 1;
  createdAt: number;
  build: number;
  settings: Record<string, unknown>;
  sort?: SortKey;
  view?: ViewMode;
  /** Collection names. */
  collections: string[];
  /** Local date -> milliseconds read. */
  days: Record<string, number>;
  books: SavedBook[];
}

export function createBackup(now = Date.now()): Backup {
  const shelves = getShelves();
  const names = new Map(shelves.collections.map((c) => [c.id, c.name]));
  const stats = getStats();
  const books = getBooks().flatMap((b): SavedBook[] => {
    // Without a readable file there's nothing to recognise the book by later.
    const fp = fingerprintBook(b);
    if (!fp) return [];
    return [
      {
        fp,
        title: b.title,
        author: b.author,
        ...(b.titleEdited ? { titleEdited: true } : {}),
        ...(b.status === 'ready' ? { engine: loadManifest(b.id)?.v } : {}),
        ...(b.position ? { position: b.position, percent: b.percent } : {}),
        ...(b.finished ? { finished: true } : {}),
        openedAt: b.openedAt,
        collections: (b.collections ?? []).flatMap((id) => names.get(id) ?? []),
        annotations: getAnnotations(b.id),
        ...(stats.books[b.id] ? { stats: stats.books[b.id] } : {}),
      },
    ];
  });
  return {
    kind: BACKUP_KIND,
    version: 1,
    createdAt: now,
    build: Number(Constants.expoConfig?.extra?.buildNumber ?? 0),
    settings: { ...getSettings() },
    sort: shelves.sort,
    view: shelves.view,
    collections: shelves.collections.map((c) => c.name),
    days: stats.days,
    books,
  };
}

// ---------- reading a backup: any file can be picked, so every field is checked ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const index = (v: unknown): v is number => num(v) && v >= 0 && Number.isInteger(v);
const str = (v: unknown): v is string => typeof v === 'string';
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const optStr = (o: Obj, k: string) => (str(o[k]) ? { [k]: o[k] as string } : {});

function position(v: unknown): Position | undefined {
  return isObj(v) && index(v.b) && index(v.o) ? { b: v.b, o: v.o } : undefined;
}

function highlight(v: unknown): Highlight[] {
  if (!isObj(v) || !str(v.id) || !index(v.b) || !index(v.s) || !index(v.e) || v.e <= v.s || !str(v.text)) return [];
  if (!str(v.color) || !(v.color in HIGHLIGHT_COLORS)) return [];
  return [
    {
      id: v.id,
      b: v.b,
      s: v.s,
      e: v.e,
      color: v.color as Highlight['color'],
      text: v.text,
      ...optStr(v, 'note'),
      ...optStr(v, 'chapter'),
      createdAt: num(v.createdAt) ? v.createdAt : 0,
    },
  ];
}

function bookmark(v: unknown): Bookmark[] {
  if (!isObj(v) || !str(v.id) || !index(v.b) || !index(v.o)) return [];
  return [{ id: v.id, b: v.b, o: v.o, snippet: str(v.snippet) ? v.snippet : '', ...optStr(v, 'chapter'), createdAt: num(v.createdAt) ? v.createdAt : 0 }];
}

function annotations(v: unknown): Annotations {
  const o = isObj(v) ? v : {};
  return { highlights: list(o.highlights).flatMap(highlight), bookmarks: list(o.bookmarks).flatMap(bookmark) };
}

function bookStats(v: unknown): BookStats | undefined {
  if (!isObj(v) || !num(v.ms) || v.ms < 0) return undefined;
  return { ms: v.ms, ...(num(v.sMs) && num(v.sChars) ? { sMs: v.sMs, sChars: v.sChars } : {}) };
}

function savedBook(v: unknown): SavedBook[] {
  if (!isObj(v) || !str(v.fp) || !v.fp) return [];
  const pos = position(v.position);
  const stats = bookStats(v.stats);
  return [
    {
      fp: v.fp,
      title: str(v.title) ? v.title : '',
      author: str(v.author) ? v.author : '',
      ...(v.titleEdited === true ? { titleEdited: true } : {}),
      ...(num(v.engine) ? { engine: v.engine } : {}),
      ...(pos ? { position: pos, ...(num(v.percent) ? { percent: Math.min(1, Math.max(0, v.percent)) } : {}) } : {}),
      ...(v.finished === true ? { finished: true } : {}),
      ...(num(v.openedAt) ? { openedAt: v.openedAt } : {}),
      collections: list(v.collections).filter(str),
      annotations: annotations(v.annotations),
      ...(stats ? { stats } : {}),
    },
  ];
}

/** A backup made by this app, checked field by field; null for anything else. */
export function parseBackup(text: string): Backup | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.kind !== BACKUP_KIND || raw.version !== 1) return null;
  const days: Record<string, number> = {};
  if (isObj(raw.days)) for (const [d, ms] of Object.entries(raw.days)) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && num(ms) && ms >= 0) days[d] = ms;
  return {
    kind: BACKUP_KIND,
    version: 1,
    createdAt: num(raw.createdAt) ? raw.createdAt : 0,
    build: num(raw.build) ? raw.build : 0,
    settings: isObj(raw.settings) ? raw.settings : {},
    ...(str(raw.sort) && raw.sort in SORT_LABELS ? { sort: raw.sort as SortKey } : {}),
    ...(raw.view === 'grid' || raw.view === 'list' ? { view: raw.view } : {}),
    collections: list(raw.collections).filter((c): c is string => str(c) && !!c.trim()),
    days,
    books: list(raw.books).flatMap(savedBook),
  };
}

export async function readBackupFile(uri: string): Promise<Backup | null> {
  return parseBackup(await new File(uri).text());
}

export interface RestoreResult {
  /** Books on this phone that got their data back. */
  applied: number;
  /** Titles of books whose data waits for their file to be added. */
  waiting: string[];
}

/**
 * Put a backup's data back. Annotations are added to what's here; reading
 * places return where the backup's are newer; collections, the library's
 * view and the reader settings come back as they were.
 */
export function restoreBackup(backup: Backup): RestoreResult {
  setSettings(sanitizeSettings(backup.settings, getSettings()));
  if (backup.sort) setSort(backup.sort);
  if (backup.view) setView(backup.view);
  const ids = new Map<string, string>();
  for (const name of new Set([...backup.collections, ...backup.books.flatMap((b) => b.collections ?? [])])) ids.set(name, collectionNamed(name).id);
  mergeDays(backup.days);

  const here = new Map<string, string>();
  for (const b of getBooks()) {
    const fp = fingerprintBook(b);
    if (fp) here.set(fp, b.id);
  }
  const waiting: SavedBook[] = [];
  let applied = 0;
  for (const saved of backup.books) {
    const local = { ...saved, collections: (saved.collections ?? []).flatMap((n) => ids.get(n) ?? []) };
    const id = here.get(saved.fp);
    const book = id ? getBooks().find((b) => b.id === id) : undefined;
    if (!book) {
      waiting.push(local);
      continue;
    }
    const patch = applySaved(book.id, book, local);
    if (Object.keys(patch).length) updateBook(book.id, patch);
    applied++;
  }
  if (waiting.length) addPending(waiting);
  flushLibrary();
  return { applied, waiting: waiting.map((w) => w.title || 'Untitled') };
}
