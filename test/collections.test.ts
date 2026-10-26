// Sorting the library: by title or author as the phone's language sorts them, ignoring case; books
// without an author last. It runs on every library change (each saved reading place), so the
// collator is made once, not per comparison.

import { expect, it, vi } from 'vitest';

vi.mock('expo-file-system', () => ({ File: class {}, Paths: { document: '' } }));
vi.mock('@/lib/storage', () => ({ readJson: () => null, saveJson: () => true }));
vi.mock('@/lib/library', () => ({ getBook: () => undefined, updateBook: () => {} }));

const book = (title: string, author = '', i = 0) =>
  ({ id: title, title, author, fileName: '', sourceName: '', size: 0, addedAt: i, openedAt: i, status: 'ready', progress: 1 }) as import('../src/lib/library').BookEntry;

it('sorts by title and by author, ignoring case, with authorless books last', async () => {
  const { sortBooks } = await import('../src/lib/collections');
  const books = [book('zebra', 'Adams'), book('Apple', ''), book('banana', 'adams'), book('Cherry', 'Brown')];
  expect(sortBooks(books, 'title').map((b) => b.title)).toEqual(['Apple', 'banana', 'Cherry', 'zebra']);
  expect(sortBooks(books, 'author').map((b) => b.title)).toEqual(['banana', 'zebra', 'Cherry', 'Apple']);
});

it('makes one collator, however often it sorts, instead of comparing (and lower-casing) anew each time', async () => {
  const { sortBooks } = await import('../src/lib/collections');
  const Collator = vi.spyOn(Intl, 'Collator');
  const localeCompare = vi.spyOn(String.prototype, 'localeCompare');
  const lower = vi.spyOn(String.prototype, 'toLocaleLowerCase');
  const books = Array.from({ length: 200 }, (_, i) => book(`Book ${(i * 7919) % 200}`, `Author ${i % 13}`, i));
  for (let k = 0; k < 5; k++) {
    sortBooks(books, 'title');
    sortBooks(books, 'author');
  }
  expect(Collator.mock.calls.length).toBeLessThanOrEqual(1);
  expect(localeCompare).not.toHaveBeenCalled();
  expect(lower).not.toHaveBeenCalled();
});
