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

export function sortBooks(books: BookEntry[], key: SortKey): BookEntry[] {
  const out = [...books];
  const text = (s: string) => s.toLocaleLowerCase();
  switch (key) {
    case 'recent':
      return out.sort((a, b) => b.openedAt - a.openedAt);
    case 'added':
      return out.sort((a, b) => b.addedAt - a.addedAt);
    case 'title':
      return out.sort((a, b) => text(a.title).localeCompare(text(b.title)));
    case 'author':
      return out.sort((a, b) => text(a.author || '￿').localeCompare(text(b.author || '￿')) || text(a.title).localeCompare(text(b.title)));
    case 'progress':
      return out.sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0));
  }
}

export const SORT_LABELS: Record<SortKey, string> = {
  recent: 'Recently read',
  added: 'Recently added',
  title: 'Title',
  author: 'Author',
  progress: 'Progress',
};
