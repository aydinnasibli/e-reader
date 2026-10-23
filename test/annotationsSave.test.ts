// A highlight made while the phone is out of space must not vanish: it stays
// in memory, the person is told once, and it is written as soon as a save works.

import { beforeEach, expect, it, vi } from 'vitest';

const disk = new Map<string, string>();
const state = { full: false, bookDirExists: true };
const alert = vi.fn();

vi.mock('react-native', () => ({ Alert: { alert: (...a: unknown[]) => alert(...a) } }));
vi.mock('expo-file-system', () => ({
  Paths: { document: 'doc' },
  File: class {
    path: string;
    constructor(...parts: string[]) {
      this.path = parts.join('/');
    }
    get parentDirectory() {
      return { exists: state.bookDirExists };
    }
  },
}));
vi.mock('@/lib/storage', () => ({
  readJson: (f: { path: string }) => (disk.has(f.path) ? JSON.parse(disk.get(f.path)!) : null),
  writeJson: (f: { path: string }, v: unknown) => {
    if (state.full) throw new Error('ENOSPC: no space left on device');
    disk.set(f.path, JSON.stringify(v));
  },
}));

const load = async () => {
  vi.resetModules();
  return import('@/lib/annotations');
};

beforeEach(() => {
  disk.clear();
  state.full = false;
  state.bookDirExists = true;
  alert.mockClear();
});

const hl = { b: 1, s: 0, e: 4, color: 'yellow' as const, text: 'Call' };

it('a highlight saved while storage is full is kept, the person is told once, and it is written later', async () => {
  const a = await load();
  state.full = true;
  a.addHighlight('moby', hl);
  a.addBookmark('moby', { b: 2, o: 0, snippet: 'x' });
  expect(a.getAnnotations('moby').highlights).toHaveLength(1);
  expect(alert).toHaveBeenCalledTimes(1);
  expect(disk.size).toBe(0);
  expect(a.flushAnnotations()).toBe(false);

  // Space is free again; going to the background saves it.
  state.full = false;
  expect(a.flushAnnotations()).toBe(true);

  // "App killed": a fresh module reads it back from disk.
  const again = await load();
  const saved = again.getAnnotations('moby');
  expect(saved.highlights.map((h) => h.text)).toEqual(['Call']);
  expect(saved.bookmarks).toHaveLength(1);
});

it('the next change retries earlier failed saves of other books too', async () => {
  const a = await load();
  state.full = true;
  a.addHighlight('one', hl);
  state.full = false;
  a.addHighlight('two', hl);
  const again = await load();
  expect(again.getAnnotations('one').highlights).toHaveLength(1);
  expect(again.getAnnotations('two').highlights).toHaveLength(1);
});

it('a deleted book is not retried or warned about', async () => {
  const a = await load();
  state.full = true;
  state.bookDirExists = false;
  a.addHighlight('gone', hl);
  expect(alert).not.toHaveBeenCalled();
  expect(a.flushAnnotations()).toBe(true);
});

it('after a save works again, a new failure warns again', async () => {
  const a = await load();
  state.full = true;
  a.addHighlight('moby', hl);
  state.full = false;
  a.addHighlight('moby', { ...hl, b: 3 });
  state.full = true;
  a.addHighlight('moby', { ...hl, b: 4 });
  expect(alert).toHaveBeenCalledTimes(2);
});
