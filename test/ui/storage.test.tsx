/// <reference types="jest" />
// Saving JSON (storage.ts writeJson/readJson) over memfs.ts. Moving the new file into place with
// { overwrite: true } is two steps natively, not one atomic rename: Android deletes the target first
// (fsops/CopyMoveStrategy.kt), then renames; iOS too (FileSystemPath.swift: removeItem, moveItem).

jest.mock('expo-file-system', () => require('./memfs'));
jest.unmock('@/lib/storage');

import * as memfs from './memfs';
import { readJson, removeJson, writeJson } from '@/lib/storage';

type F = import('expo-file-system').File;
const file = () => new memfs.File(memfs.Paths.document, 'books', 'b1', 'annotations.json') as unknown as F;
const sibling = (suffix: string) => new memfs.File(file().uri + suffix);

beforeEach(() => {
  memfs.resetDisk();
  new memfs.Directory(memfs.Paths.document, 'books', 'b1').create({ intermediates: true });
});

it('killed between deleting the old file and renaming the new one, the next start gets the newest complete save', () => {
  writeJson(file(), { highlights: ['first'] });
  // The native move with overwrite: the target is deleted, then the process dies before the rename.
  const move = jest.spyOn(memfs.File.prototype, 'moveSync').mockImplementation(function (this: memfs.File, dest, o) {
    if (o?.overwrite && dest.exists) (dest as memfs.File).delete();
    throw new Error('process killed');
  });
  try {
    writeJson(file(), { highlights: ['first', 'second, with a note'] });
  } catch {
    // the app is gone
  } finally {
    move.mockRestore();
  }
  // Next start: what is on disk.
  expect(memfs.disk.has(file().uri)).toBe(false);
  expect(readJson(file())).toEqual({ highlights: ['first', 'second, with a note'] });
});

it('a save cut short while writing the new file leaves the last good one in use', () => {
  writeJson(file(), { v: 1 });
  writeJson(file(), { v: 2 });
  // Half a .tmp: not JSON.
  memfs.putFile(sibling('.tmp').uri, new TextEncoder().encode('{"v":'));
  expect(readJson(file())).toEqual({ v: 2 });
});

it('a damaged file is read from its backup, and kept aside (not made the backup) when next saved', () => {
  writeJson(file(), { v: 1 });
  writeJson(file(), { v: 2 }); // .bak is { v: 1 }
  memfs.putFile(file().uri, new TextEncoder().encode('\u0000\u0000garbage'));
  expect(readJson(file())).toEqual({ v: 1 });
  writeJson(file(), { v: 3 });
  expect(readJson(file())).toEqual({ v: 3 });
  // The good backup is still the good one, and the damaged file is there to look at.
  expect(JSON.parse(sibling('.bak').textSync())).toEqual({ v: 1 });
  expect(sibling('.unreadable').textSync()).toContain('garbage');
});

it('removing a file removes every copy kept of it, the damaged one kept aside too', () => {
  writeJson(file(), { v: 1 });
  writeJson(file(), { v: 2 });
  memfs.putFile(file().uri, new TextEncoder().encode('garbage'));
  readJson(file());
  writeJson(file(), { v: 3 }); // the damaged one is now .unreadable
  memfs.putFile(sibling('.tmp').uri, new TextEncoder().encode('{"v":'));
  expect(memfs.disk.has(sibling('.unreadable').uri)).toBe(true);
  removeJson(file());
  expect([...memfs.disk.keys()].filter((k) => k.startsWith(file().uri))).toEqual([]);
});

it('JSON of another shape than the file holds counts as damaged: its saved copy is read instead', () => {
  writeJson(file(), [1, 2]);
  writeJson(file(), { not: 'a list' });
  expect(readJson(file(), Array.isArray)).toEqual([1, 2]);
  // Kept aside when next saved, not made the backup.
  writeJson(file(), [3]);
  expect(JSON.parse(sibling('.bak').textSync())).toEqual([1, 2]);
  expect(JSON.parse(sibling('.unreadable').textSync())).toEqual({ not: 'a list' });
});
