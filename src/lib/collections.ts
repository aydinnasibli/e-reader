// User-made collections (shelves) and the library's view preferences.

import { File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { type BookEntry, getBook, updateBook } from './library';
import { readJson, saveJson } from './storage';

export interface Collection {
  id: string;
  name: string;
}

export type SortKey = 'recent' | 'added' | 'title' | 'author' | 'progress';
export type ViewMode = 'grid' | 'list';

interface State {
  collections: Collection[];
  sort: SortKey;
  view: ViewMode;
}

const file = () => new File(Paths.document, 'shelves.json');
let state: State | null = null;
const listeners = new Set<() => void>();

function get(): State {
  if (!state) state = { collections: [], sort: 'recent', view: 'grid', ...(readJson<Partial<State>>(file()) ?? {}) };
  return state;
}

function set(patch: Partial<State>) {
  state = { ...get(), ...patch };
  saveJson(file(), state);
  listeners.forEach((l) => l());
}

export function useShelves(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    get,
  );
}

export function setSort(sort: SortKey) {
  set({ sort });
}

export function setView(view: ViewMode) {
  set({ view });
}

export function getShelves(): Readonly<State> {
  return get();
}

/** The collection with this name, made if there is none (restoring a backup). */
export function collectionNamed(name: string): Collection {
  return get().collections.find((c) => c.name === name) ?? createCollection(name);
}

export function createCollection(name: string): Collection {
  const c = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name };
  set({ collections: [...get().collections, c] });
  return c;
}

export function renameCollection(id: string, name: string) {
  set({ collections: get().collections.map((c) => (c.id === id ? { ...c, name } : c)) });
}

export function deleteCollection(id: string, books: BookEntry[]) {
  set({ collections: get().collections.filter((c) => c.id !== id) });
  for (const b of books) if (b.collections?.includes(id)) updateBook(b.id, { collections: b.collections.filter((x) => x !== id) });
}

export function toggleInCollection(bookId: string, collectionId: string) {
  const b = getBook(bookId);
  if (!b) return;
  const has = b.collections?.includes(collectionId);
  updateBook(bookId, {
    collections: has ? b.collections!.filter((x) => x !== collectionId) : [...(b.collections ?? []), collectionId],
  });
}

/** Built-in filters plus user collections. */
export type Filter = { kind: 'all' } | { kind: 'reading' } | { kind: 'finished' } | { kind: 'collection'; id: string };

export function isFinished(b: BookEntry) {
  return b.finished ?? (b.percent ?? 0) >= 0.995;
}

export function matches(b: BookEntry, f: Filter): boolean {
  switch (f.kind) {
    case 'all':
      return true;
    case 'reading':
      return !isFinished(b) && (b.percent ?? 0) > 0;
    case 'finished':
      return isFinished(b);
    case 'collection':
      return !!b.collections?.includes(f.id);
  }
}

let collator: Intl.Collator | null = null;
/** Compares titles and names as the phone's language sorts them, ignoring case (made once: making one is slow). */
function compare(a: string, b: string): number {
  try {
    collator ??= new Intl.Collator(undefined, { sensitivity: 'accent' });
    return collator.compare(a, b);
  } catch {
    return a.toLocaleLowerCase() < b.toLocaleLowerCase() ? -1 : a.toLocaleLowerCase() > b.toLocaleLowerCase() ? 1 : 0;
  }
}

/** Books sorted by `key`. Runs on every library change (each saved reading place), so each book's sort text is worked out once. */
export function sortBooks(books: BookEntry[], key: SortKey): BookEntry[] {
  const out = [...books];
  switch (key) {
    case 'recent':
      return out.sort((a, b) => b.openedAt - a.openedAt);
    case 'added':
      return out.sort((a, b) => b.addedAt - a.addedAt);
    case 'progress':
      return out.sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0));
    case 'title':
    case 'author': {
      // Books without an author go last.
      const keyed = out.map((b) => ({ b, author: b.author.trim(), title: b.title.trim() }));
      keyed.sort((x, y) => {
        if (key === 'author' && !x.author !== !y.author) return x.author ? -1 : 1;
        return (key === 'author' ? compare(x.author, y.author) : 0) || compare(x.title, y.title);
      });
      return keyed.map((x) => x.b);
    }
  }
}

export const SORT_LABELS: Record<SortKey, string> = {
  recent: 'Recently read',
  added: 'Recently added',
  title: 'Title',
  author: 'Author',
  progress: 'Progress',
};
