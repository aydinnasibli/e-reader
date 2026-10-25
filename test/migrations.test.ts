// Saved files are brought up to date one version at a time, each step once;
// a step that fails is recorded and tried again next start.

import { beforeEach, expect, it, vi } from 'vitest';

const disk = new Map<string, string>();
const recorded: unknown[] = [];

vi.mock('expo-file-system', () => ({
  Paths: { document: 'doc' },
  File: class {
    path: string;
    constructor(...parts: string[]) {
      this.path = parts.join('/');
    }
  },
}));
vi.mock('@/lib/storage', () => ({
  readJson: (f: { path: string }) => (disk.has(f.path) ? JSON.parse(disk.get(f.path)!) : null),
  writeJson: (f: { path: string }, v: unknown) => disk.set(f.path, JSON.stringify(v)),
}));
vi.mock('@/lib/crashLog', () => ({ recordCrash: (_kind: string, e: unknown) => recorded.push(e) }));

const { STORAGE_VERSION, migrateStorage } = await import('@/lib/migrations');
const version = () => JSON.parse(disk.get('doc/storage.json') ?? 'null')?.version;

beforeEach(() => {
  disk.clear();
  recorded.length = 0;
});

it('stamps the current version on files from before versioning', () => {
  expect(migrateStorage()).toBe('current');
  expect(version()).toBe(STORAGE_VERSION);
});

it('runs each step once, in order, from the saved version', () => {
  const ran: number[] = [];
  const steps = [2, 3, 4].map((to) => ({ to, run: () => ran.push(to) }));
  disk.set('doc/storage.json', JSON.stringify({ version: 2 }));
  expect(migrateStorage(steps, 4)).toBe('migrated');
  expect(ran).toEqual([3, 4]);
  expect(version()).toBe(4);
  expect(migrateStorage(steps, 4)).toBe('current');
  expect(ran).toEqual([3, 4]);
});

it('a failing step is recorded, keeps the steps before it, and is retried next start', () => {
  let broken = true;
  const ran: number[] = [];
  const steps = [
    { to: 2, run: () => ran.push(2) },
    {
      to: 3,
      run: () => {
        if (broken) throw new Error('disk full');
        ran.push(3);
      },
    },
  ];
  expect(migrateStorage(steps, 3)).toBe('failed');
  expect(version()).toBe(2);
  expect(recorded).toHaveLength(1);
  broken = false;
  expect(migrateStorage(steps, 3)).toBe('migrated');
  expect(ran).toEqual([2, 3]);
  expect(version()).toBe(3);
});

it('leaves files from a newer build alone', () => {
  disk.set('doc/storage.json', JSON.stringify({ version: STORAGE_VERSION + 1 }));
  expect(migrateStorage([{ to: STORAGE_VERSION + 1, run: () => {} }])).toBe('newer');
  expect(version()).toBe(STORAGE_VERSION + 1);
});
