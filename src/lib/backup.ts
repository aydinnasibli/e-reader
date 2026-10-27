// A backup of what the person made in the app, as one JSON file to keep
// anywhere (Files, a drive, a message to oneself) and restore on any phone,
// Android or iPhone: highlights, notes and bookmarks, reading places,
// finished marks, edited titles, collections, reading stats and settings.
// Not the books: a book's data waits until the same file is added again
// (restore.ts).

import Constants from 'expo-constants';
import { File } from 'expo-file-system';
import { normaliseLanguage } from '@/engine/language';
import { ENGINE_VERSION, type Manifest, type Position } from '@/engine/types';
import { HIGHLIGHT_COLORS } from '@/ui/theme';
import { type Annotations, type Bookmark, type Highlight, getAnnotations } from './annotations';
import { SORT_LABELS, type SortKey, type ViewMode, collectionNamed, getShelves, setSort, setView } from './collections';
import { ownKey } from './guards';
import { type BookEntry, bookConversion, fingerprintBook, flushLibrary, getBooks, loadManifest, queueMarks, updateBook, withoutSwaps } from './library';
import { anchorsOn, marksOf } from './remap';
import { type SavedAnchor, type SavedBook, addPending, applySaved } from './restore';
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

/**
 * Where a book's marks are in its conversion, with their text and the text
 * around them, so that a phone with another conversion of the book (another
 * converter version) finds them all the same. Highlights' own text is left
 * out: it is the highlight's.
 */
async function anchorsFor(b: BookEntry, ann: Annotations, manifest: Manifest): Promise<Record<string, SavedAnchor> | undefined> {
  if (!ann.highlights.length && !ann.bookmarks.length && !b.position) return undefined;
  try {
    const conv = bookConversion(b.id, manifest);
    if (!conv) return undefined;
    const anchors: Record<string, SavedAnchor> = await anchorsOn(conv, marksOf(ann.highlights, ann.bookmarks, b.position));
    const own = new Map(ann.highlights.map((h) => [`h${h.id}`, h.text]));
    for (const [key, a] of Object.entries(anchors)) {
      if (own.get(key) !== a.text) continue;
      const saved = { ...a };
      delete saved.text;
      anchors[key] = saved;
    }
    return anchors;
  } catch {
    return undefined; // the block numbers and texts are still there
  }
}

export interface BackupReport {
  backup: Backup;
  /** Titles of books left out: without their file (or its fingerprint) another phone can't tell which book they are. */
  skipped: string[];
}

/** A backup of everything; no book's new conversion is swapped in while it is made (library.ts withoutSwaps). */
export function createBackupReport(now = Date.now()): Promise<BackupReport> {
  return withoutSwaps(() => makeBackup(now));
}

export async function createBackup(now = Date.now()): Promise<Backup> {
  return (await createBackupReport(now)).backup;
}

async function makeBackup(now: number): Promise<BackupReport> {
  const shelves = getShelves();
  const names = new Map(shelves.collections.map((c) => [c.id, c.name]));
  const stats = getStats();
  const books: SavedBook[] = [];
  const skipped: string[] = [];
  for (const b of getBooks()) {
    // Without a readable file there's nothing to recognise the book by later.
    const fp = fingerprintBook(b);
    if (!fp) {
      skipped.push(b.title || 'Untitled');
      continue;
    }
    const annotations = getAnnotations(b.id);
    // One conversion's manifest for both its version and the anchors read from it.
    const manifest = b.status === 'ready' ? loadManifest(b.id) : null;
    const anchors = manifest ? await anchorsFor(b, annotations, manifest) : undefined;
    books.push({
      fp,
      title: b.title,
      author: b.author,
      ...(b.titleEdited ? { titleEdited: true } : {}),
      ...(manifest ? { engine: manifest.v } : {}),
      ...(b.position ? { position: b.position, percent: b.percent } : {}),
      ...(b.finished ? { finished: true } : {}),
      openedAt: b.openedAt,
      collections: (b.collections ?? []).flatMap((id) => names.get(id) ?? []),
      annotations,
      ...(anchors ? { anchors } : {}),
      ...(b.lang ? { lang: b.lang } : {}),
      ...(stats.books[b.id] ? { stats: stats.books[b.id] } : {}),
    });
  }
  const backup: Backup = {
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
  return { backup, skipped };
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
  // Its own keys only: "constructor" is `in` every object.
  if (!ownKey(HIGHLIGHT_COLORS, v.color)) return [];
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

/** Longest text kept in an anchor (a long highlight's own text is the highlight's). */
const ANCHOR_TEXT = 4000;

function anchors(v: unknown, ann: Annotations): Record<string, SavedAnchor> | undefined {
  if (!isObj(v)) return undefined;
  const keys = new Set(['place', ...ann.highlights.map((h) => `h${h.id}`), ...ann.bookmarks.map((x) => `m${x.id}`)]);
  const out: Record<string, SavedAnchor> = {};
  for (const [key, a] of Object.entries(v)) {
    if (!keys.has(key) || !isObj(a)) continue;
    const at = num(a.at) && a.at >= 0 && a.at <= 1 ? { at: a.at } : index(a.b) && index(a.o) ? { b: a.b, o: a.o } : null;
    if (!at) continue;
    const text = (k: string, max: number) => (str(a[k]) ? { [k]: (a[k] as string).slice(0, max) } : {});
    out[key] = { ...at, ...text('text', ANCHOR_TEXT), ...text('before', 200), ...text('after', 200) } as SavedAnchor;
  }
  return Object.keys(out).length ? out : undefined;
}

function bookStats(v: unknown): BookStats | undefined {
  if (!isObj(v) || !num(v.ms) || v.ms < 0) return undefined;
  return { ms: v.ms, ...(num(v.sMs) && num(v.sChars) ? { sMs: v.sMs, sChars: v.sChars } : {}) };
}

function savedBook(v: unknown): SavedBook[] {
  if (!isObj(v) || !str(v.fp) || !v.fp) return [];
  const pos = position(v.position);
  const stats = bookStats(v.stats);
  const ann = annotations(v.annotations);
  const marks = anchors(v.anchors, ann);
  const lang = str(v.lang) ? normaliseLanguage(v.lang) : undefined;
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
      annotations: ann,
      ...(marks ? { anchors: marks } : {}),
      ...(lang ? { lang } : {}),
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
    ...(ownKey(SORT_LABELS, raw.sort) ? { sort: raw.sort as SortKey } : {}),
    ...(raw.view === 'grid' || raw.view === 'list' ? { view: raw.view } : {}),
    collections: list(raw.collections).filter((c): c is string => str(c) && !!c.trim()),
    days,
    books: list(raw.books).flatMap(savedBook),
  };
}

/** Bigger than any backup this app makes (thousands of highlights are a few MB): not read at all. */
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;

/** The picked file is too big to be a backup. */
export class BackupTooBig extends Error {}

/** Read a picked file as a backup; `size` is what the picker says, if anything. */
export async function readBackupFile(uri: string, size?: number): Promise<Backup | null> {
  const file = new File(uri);
  if ((size || file.size || 0) > MAX_BACKUP_BYTES) throw new BackupTooBig();
  return parseBackup(await file.text());
}

export interface RestoreResult {
  /** Books on this phone that got their data back. */
  applied: number;
  /** Titles of books whose data waits for their file to be added. */
  waiting: string[];
  /** Titles of books whose data couldn't be saved (the phone is full): restoring again later puts it back. */
  failed: string[];
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
  const failed: string[] = [];
  let applied = 0;
  for (const saved of backup.books) {
    const local = { ...saved, collections: (saved.collections ?? []).flatMap((n) => ids.get(n) ?? []) };
    const id = here.get(saved.fp);
    const book = id ? getBooks().find((b) => b.id === id) : undefined;
    if (!book) {
      waiting.push(local);
      continue;
    }
    // The converter version of this phone's conversion of the book: the backup's block numbers are only good for that one.
    const converted = book.status === 'ready' ? (book.engine ?? loadManifest(book.id)?.v) : ENGINE_VERSION;
    try {
      const patch = applySaved(book.id, book, local, converted, queueMarks);
      if (Object.keys(patch).length) updateBook(book.id, patch);
      applied++;
    } catch {
      // Its marks couldn't be saved to be placed (the phone is full); the others go on.
      failed.push(saved.title || 'Untitled');
    }
  }
  const title = (w: SavedBook) => w.title || 'Untitled';
  if (waiting.length && !addPending(waiting)) failed.push(...waiting.map(title));
  flushLibrary();
  return { applied, waiting: waiting.map(title), failed };
}
