/// <reference types="jest" />
// The shelf's own file, library.json, over memfs.ts: one of another shape (damaged, hand-edited)
// can't stop every start; a save that fails (a full phone) keeps the changes, says so once and is
// done once there's room; and the saved files are brought up to date (migrations.ts) before the
// library reads them, whoever loads it first ("Open with" can come before the root layout).

jest.mock('expo-file-system', () => require('./memfs'));
jest.unmock('@/lib/storage');
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

import { strToU8 } from 'fflate';
import { ENGINE_VERSION } from '@/engine/types';

const memfs = require('./memfs') as typeof import('./memfs');

/** A book on the shelf, converted by this version (nothing to do in the background). */
const entry = (id: string, title: string) => ({ id, title, author: '', fileName: `${id}.epub`, sourceName: 'source.epub', size: 1, addedAt: 1, openedAt: 1, status: 'ready', progress: 1, engine: ENGINE_VERSION });
const put = (name: string, v: unknown) => memfs.putFile(`mem://doc/${name}`, strToU8(JSON.stringify(v)));
const read = (name: string) => JSON.parse(new memfs.File(`mem://doc/${name}`).textSync());

const running: (typeof import('@/lib/library'))[] = [];
/** Start the app afresh (only what's on disk). */
function app() {
  jest.resetModules();
  const lib = require('@/lib/library') as typeof import('@/lib/library');
  running.push(lib);
  return lib;
}
// Nothing an earlier "app" has pending is saved over the next test's disk.
afterEach(() => running.splice(0).forEach((l) => l.flushLibrary()));
beforeEach(() => memfs.resetDisk());
// A failed save is also written to the console (storage.ts saveJson): expected here.
beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

it('a library.json of another shape (not a list) is read from its saved copy instead of stopping every start', () => {
  put('library.json', { books: [] });
  put('library.json.bak', [entry('a', 'Moby Dick')]);
  const lib = app();
  expect(() => lib.loadLibrary()).not.toThrow();
  expect(lib.getBooks().map((b) => b.title)).toEqual(['Moby Dick']);
});

it('entries the app can’t use are left out, and the rest of the shelf stays', () => {
  put('library.json', [null, 'junk', { id: 7 }, { ...entry('b', 'Persuasion'), title: 42 }, entry('c', 'Emma')]);
  const lib = app();
  expect(() => lib.loadLibrary()).not.toThrow();
  expect(lib.getBooks().map((b) => [b.id, b.title])).toEqual([
    ['b', 'Untitled'],
    ['c', 'Emma'],
  ]);
});

it('a save that fails (a full phone) keeps the change, says so once, and is done once there’s room', () => {
  put('library.json', [entry('a', 'Moby Dick')]);
  const lib = app();
  lib.loadLibrary();
  const alert = jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(() => {});
  try {
    memfs.setFreeSpace(0);
    try {
      lib.updateBook('a', { percent: 0.5 });
      expect(lib.flushLibrary()).toBe(false);
      lib.updateBook('a', { percent: 0.6 });
      expect(lib.flushLibrary()).toBe(false);
    } finally {
      memfs.setFreeSpace(undefined);
    }
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith('Couldn’t save', expect.stringContaining('reading places'));
    expect(lib.getBook('a')?.percent).toBe(0.6);

    expect(lib.flushLibrary()).toBe(true);
    expect(read('library.json')[0].percent).toBe(0.6);
    // Failing again later is said again.
    memfs.setFreeSpace(0);
    try {
      lib.updateBook('a', { percent: 0.7 });
      lib.flushLibrary();
    } finally {
      memfs.setFreeSpace(undefined);
    }
    expect(alert).toHaveBeenCalledTimes(2);
  } finally {
    alert.mockRestore();
  }
});

it('a save that failed is tried again by itself, without waiting for the next change', () => {
  jest.useFakeTimers();
  try {
    put('library.json', [entry('a', 'Moby Dick')]);
    const lib = app();
    lib.loadLibrary();
    const alert = jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(() => {});
    memfs.setFreeSpace(0);
    lib.updateBook('a', { percent: 0.5 });
    jest.advanceTimersByTime(1000); // the usual save, a moment after the change: fails
    memfs.setFreeSpace(undefined);
    expect(read('library.json')[0].percent).toBeUndefined();
    jest.advanceTimersByTime(30_000);
    expect(read('library.json')[0].percent).toBe(0.5);
    alert.mockRestore();
  } finally {
    jest.useRealTimers();
  }
});

it('the saved files are brought up to date before the library reads them, whoever loads it first', () => {
  put('library.json', [entry('a', 'Old layout')]);
  jest.resetModules();
  // A migration step that changes library.json, as a future one may.
  jest.doMock('@/lib/migrations', () => ({ migrateOnce: () => put('library.json', [entry('a', 'New layout')]) }));
  try {
    const lib = require('@/lib/library') as typeof import('@/lib/library');
    running.push(lib);
    lib.loadLibrary();
    expect(lib.getBook('a')?.title).toBe('New layout');
  } finally {
    jest.dontMock('@/lib/migrations');
  }
  // The real thing stamps the version the files are at.
  const lib = app();
  lib.loadLibrary();
  expect(read('storage.json')).toEqual({ version: (require('@/lib/migrations') as typeof import('@/lib/migrations')).STORAGE_VERSION });
});
