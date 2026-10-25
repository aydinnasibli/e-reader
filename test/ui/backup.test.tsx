/// <reference types="jest" />
// Backup and restore through the real library, storage and conversion, with
// only the file system and the document picker replaced. A backup made on one
// phone is restored on a "new phone" (empty disk, fresh modules): settings
// and collections come back at once, and the book's highlights, bookmark,
// place and collection come back when the same book file is added.

import { strToU8, zipSync } from 'fflate';
import { waitFor } from '@testing-library/react-native';

jest.mock('expo-file-system', () => require('./memfs'));
jest.unmock('@/lib/storage');
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

const para = (i: number) => `Paragraph ${i}. ` + 'The sea was calm and the sky was wide. '.repeat(3);
const EPUB = zipSync({
  mimetype: strToU8('application/epub+zip'),
  'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OEBPS/c.opf"/></rootfiles></container>'),
  'OEBPS/c.opf': strToU8(
    '<package><metadata><dc:title>The Sea</dc:title><dc:creator>A. Sailor</dc:creator></metadata>' +
      '<manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>',
  ),
  'OEBPS/a.xhtml': strToU8(`<html><body><h1>Chapter One</h1>${Array.from({ length: 20 }, (_, i) => `<p>${para(i)}</p>`).join('')}</body></html>`),
});

const memfs = require('./memfs') as typeof import('./memfs');

/** The app's modules as a fresh start loads them. */
function app() {
  const library = require('@/lib/library') as typeof import('@/lib/library');
  library.loadLibrary();
  return {
    library,
    annotations: require('@/lib/annotations') as typeof import('@/lib/annotations'),
    backup: require('@/lib/backup') as typeof import('@/lib/backup'),
    restore: require('@/lib/restore') as typeof import('@/lib/restore'),
    settings: require('@/lib/settings') as typeof import('@/lib/settings'),
    collections: require('@/lib/collections') as typeof import('@/lib/collections'),
  };
}

/** Add the book with the file picker (under another file name: books are recognised by their bytes). */
async function addBook(a: ReturnType<typeof app>, name: string) {
  memfs.putFile(`mem://cache/DocumentPicker/${name}`, EPUB);
  (require('expo-document-picker').getDocumentAsync as jest.Mock).mockResolvedValue({
    canceled: false,
    assets: [{ uri: `mem://cache/DocumentPicker/${name}`, name, size: EPUB.length }],
  });
  expect((await a.library.importBooks()).added).toBe(1);
  const id = a.library.getBooks()[0].id;
  await waitFor(() => expect(a.library.getBook(id)?.status).toBe('ready'), { timeout: 10000 });
  return id;
}

it('a backup restored on a new phone gives the book its highlights, bookmark, place and collection back once the file is added', async () => {
  memfs.resetDisk();
  let a = app();
  const id = await addBook(a, 'the-sea.epub');
  a.annotations.addHighlight(id, { b: 3, s: 0, e: 9, color: 'green', text: 'Paragraph', note: 'Mine' });
  a.annotations.addBookmark(id, { b: 5, o: 0, snippet: 'Paragraph 4.' });
  a.library.updateBook(id, { position: { b: 7, o: 12 }, percent: 0.35, openedAt: Date.now() });
  const col = a.collections.createCollection('Sea stories');
  a.collections.toggleInCollection(id, col.id);
  a.settings.setSettings({ fontSize: 23, theme: 'sepia' });
  const json = JSON.stringify(a.backup.createBackup());

  // ---- a new phone: nothing on disk, the app starts fresh ----
  memfs.resetDisk();
  jest.resetModules();
  a = app();
  const parsed = a.backup.parseBackup(json);
  expect(parsed).not.toBeNull();
  expect(a.backup.restoreBackup(parsed!)).toEqual({ applied: 0, waiting: ['The Sea'] });
  expect(a.settings.getSettings()).toMatchObject({ fontSize: 23, theme: 'sepia' });
  expect(a.collections.getShelves().collections.map((c) => c.name)).toEqual(['Sea stories']);
  expect(a.restore.pendingRestores()).toHaveLength(1);

  // Closed and opened again before the book is added: the waiting data is on disk.
  jest.resetModules();
  a = app();
  const newId = await addBook(a, 'Downloaded (1).epub');
  const book = a.library.getBook(newId)!;
  expect(book.position).toEqual({ b: 7, o: 12 });
  expect(book.collections).toEqual([a.collections.getShelves().collections[0].id]);
  const ann = a.annotations.getAnnotations(newId);
  expect(ann.highlights.map((h) => [h.text, h.note, h.color])).toEqual([['Paragraph', 'Mine', 'green']]);
  expect(ann.bookmarks.map((x) => x.b)).toEqual([5]);
  expect(a.restore.pendingRestores()).toHaveLength(0);

  // Restoring the same backup again adds nothing twice.
  expect(a.backup.restoreBackup(parsed!).applied).toBe(1);
  expect(a.annotations.getAnnotations(newId).highlights).toHaveLength(1);
  expect(a.collections.getShelves().collections).toHaveLength(1);
}, 60000);

it('files that are not backups, or damaged ones, are refused or cleaned field by field', () => {
  const { parseBackup } = require('@/lib/backup') as typeof import('@/lib/backup');
  expect(parseBackup('not json')).toBeNull();
  expect(parseBackup('{"kind":"something-else","version":1}')).toBeNull();
  expect(parseBackup('{"kind":"nec-reader-backup","version":2}')).toBeNull();
  const b = parseBackup(
    JSON.stringify({
      kind: 'nec-reader-backup',
      version: 1,
      settings: { fontSize: 'huge' },
      days: { '2026-10-24': 60000, '../x': 5 },
      books: [
        { title: 'no fingerprint' },
        {
          fp: '1:a:b',
          title: 'Ok',
          position: { b: -1, o: 0 },
          annotations: {
            highlights: [
              { id: 'h1', b: 1, s: 0, e: 4, color: 'green', text: 'Call' },
              { id: 'h2', b: 1, s: 4, e: 2, color: 'green', text: 'backwards' },
              { id: 'h3', b: 1, s: 0, e: 4, color: 'ultraviolet', text: 'unknown colour' },
            ],
            bookmarks: [{ id: 'm1', b: 'x', o: 0 }],
          },
        },
      ],
    }),
  )!;
  expect(b.days).toEqual({ '2026-10-24': 60000 });
  expect(b.books).toHaveLength(1);
  expect(b.books[0].position).toBeUndefined();
  expect(b.books[0].annotations.highlights.map((h) => h.id)).toEqual(['h1']);
  expect(b.books[0].annotations.bookmarks).toEqual([]);
  // A bad setting falls back to what's set now.
  const settings = require('@/lib/settings') as typeof import('@/lib/settings');
  expect(settings.sanitizeSettings(b.settings, settings.getSettings()).fontSize).toBe(settings.getSettings().fontSize);
});
