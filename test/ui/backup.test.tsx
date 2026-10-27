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
// The share sheet: a backup handed to it is saved or sent as a file.
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(() => Promise.resolve(true)), shareAsync: jest.fn(() => Promise.resolve()) }));

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
  const json = JSON.stringify(await a.backup.createBackup());

  // ---- a new phone: nothing on disk, the app starts fresh ----
  memfs.resetDisk();
  jest.resetModules();
  a = app();
  const parsed = a.backup.parseBackup(json);
  expect(parsed).not.toBeNull();
  expect(a.backup.restoreBackup(parsed!)).toEqual({ applied: 0, waiting: ['The Sea'], failed: [] });
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

// ---------- backups made from another conversion of the book (another converter version) ----------

describe('a backup from a book converted by another version of the converter', () => {
  const old = require('./oldBook') as typeof import('./oldBook');
  const { fingerprintOf } = require('@/lib/fingerprint') as typeof import('@/lib/fingerprint');
  const fp = fingerprintOf({ size: old.EPUB.length, read: (o: number, n: number) => old.EPUB.slice(o, o + n) });

  /** The book's file added with the picker on this phone (converted by this version). */
  async function addSea(a: ReturnType<typeof app>) {
    memfs.putFile('mem://cache/picked/the-sea.epub', old.EPUB);
    (require('expo-document-picker').getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'mem://cache/picked/the-sea.epub', name: 'the-sea.epub', size: old.EPUB.length }],
    });
    expect((await a.library.importBooks()).added).toBe(1);
    const id = a.library.getBooks()[0].id;
    await waitFor(() => expect(a.library.getBook(id)?.status).toBe('ready'), { timeout: 10000 });
    await waitFor(() => expect(a.library.getBook(id)?.marksWaiting).toBeFalsy(), { timeout: 10000 });
    return id;
  }

  /** The marks, as this phone's conversion of the book has them, in the shape oldBook.ts checks. */
  function movedTo(id: string) {
    const dirOf = `mem://doc/books/${id}`;
    const readHere = <T,>(path: string) => JSON.parse(new memfs.File(`${dirOf}/${path}`).textSync()) as T;
    return { ann: (require('@/lib/annotations') as typeof import('@/lib/annotations')).getAnnotations(id), readHere };
  }

  /** A backup made on a phone where the book was still the older conversion (oldBook.ts). */
  async function backupFromOldConversion() {
    jest.resetModules();
    old.oldBook({ fp, upgradeFailed: 2, lang: 'en' });
    const a = app();
    a.library.setBookLanguage(old.ID, 'tr');
    return JSON.stringify(await a.backup.createBackup());
  }

  it('its marks and place land on the same words once the file is added here', async () => {
    const json = await backupFromOldConversion();
    expect(JSON.parse(json).books[0]).toMatchObject({ engine: 1, lang: 'tr', anchors: expect.any(Object) });
    // A new phone: restored first, the book added after.
    memfs.resetDisk();
    jest.resetModules();
    let a = app();
    expect(a.backup.restoreBackup(a.backup.parseBackup(json)!)).toMatchObject({ applied: 0, waiting: ['The Sea'] });
    jest.resetModules();
    a = app();
    const id = await addSea(a);
    const { ann, readHere } = movedTo(id);
    // Checked against this phone's conversion, as oldBook.ts's helpers do for the book "sea".
    const here = (b: number) => {
      const m = readHere<import('@/engine/types').Manifest>('manifest.json');
      let c = 0;
      while (c + 1 < m.chunks.length && m.chunks[c + 1][0] <= b) c++;
      return (require('@/engine/types') as typeof import('@/engine/types')).blockText(readHere<{ b: import('@/engine/types').Block[] }>(`c/${c}.json`).b[b - m.chunks[c][0]]);
    };
    const the = ann.highlights.find((h) => h.id === 'the')!;
    expect(here(the.b).startsWith('Paragraph 20.')).toBe(true);
    expect(here(the.b).slice(the.s, the.e)).toBe('the');
    expect(the).toMatchObject({ note: 'mine', color: 'green' });
    const ship = ann.highlights.find((h) => h.id === 'ship')!;
    expect(here(ship.b).slice(ship.s, ship.e)).toBe('island number 231');
    expect(here(ann.bookmarks[0].b)).toBe(old.para(28));
    expect(ann.highlights.map((h) => h.id).sort()).toEqual(['birds', 'gone', 'ship', 'the']);
    const book = a.library.getBook(id)!;
    expect(here(book.position!.b)).toBe(old.para(25));
    expect(book.position!.o).toBe(10);
    expect(book.lang).toBe('tr');
  }, 60000);

  it('restored onto the book already here (converted by this version): its marks are found by their text', async () => {
    const json = await backupFromOldConversion();
    memfs.resetDisk();
    jest.resetModules();
    const a = app();
    const id = await addSea(a);
    expect(a.backup.restoreBackup(a.backup.parseBackup(json)!).applied).toBe(1);
    await waitFor(() => expect(a.library.getBook(id)?.marksWaiting).toBeFalsy(), { timeout: 10000 });
    const ann = a.annotations.getAnnotations(id);
    expect(ann.highlights.map((h) => h.id).sort()).toEqual(['birds', 'gone', 'ship', 'the']);
    const ship = ann.highlights.find((h) => h.id === 'ship')!;
    expect(ship.b).toBe(1 + 33); // after the heading: the paragraph's block in this conversion
    // Restoring the same backup again adds nothing twice.
    a.backup.restoreBackup(a.backup.parseBackup(json)!);
    await waitFor(() => expect(a.library.getBook(id)?.marksWaiting).toBeFalsy(), { timeout: 10000 });
    expect(a.annotations.getAnnotations(id).highlights).toHaveLength(4);
  }, 60000);

  it('a backup made by build 27 (no anchors) still finds marks with their own text, and the place by its share of the book', async () => {
    jest.resetModules();
    const { annotations } = old.oldBook();
    const backup = {
      kind: 'nec-reader-backup',
      version: 1,
      createdAt: 1,
      build: 27,
      settings: {},
      collections: [],
      days: {},
      books: [{ fp, title: 'The Sea', author: 'A. Sailor', engine: 1, position: { b: old.OLD_FIRST + 25, o: 10 }, percent: 0.63, openedAt: 5, collections: [], annotations }],
    };
    memfs.resetDisk();
    jest.resetModules();
    const a = app();
    const id = await addSea(a);
    a.backup.restoreBackup(a.backup.parseBackup(JSON.stringify(backup))!);
    await waitFor(() => expect(a.library.getBook(id)?.marksWaiting).toBeFalsy(), { timeout: 10000 });
    const ann = a.annotations.getAnnotations(id);
    expect(ann.highlights).toHaveLength(4); // none dropped
    expect(ann.highlights.find((h) => h.id === 'ship')!.b).toBe(1 + 33);
    expect(ann.bookmarks[0].b).toBe(1 + 28);
    const place = a.library.getBook(id)!.position!.b;
    expect(Math.abs(place - (1 + 25))).toBeLessThanOrEqual(1);
  }, 60000);
});

it('a picked file far bigger than any backup isn’t read at all', async () => {
  memfs.resetDisk();
  memfs.putFile('mem://cache/picked/movie.mp4', strToU8('{"kind":"nec-reader-backup"}'));
  const { readBackupFile, BackupTooBig, MAX_BACKUP_BYTES } = require('@/lib/backup') as typeof import('@/lib/backup');
  const text = jest.spyOn((require('expo-file-system') as typeof import('./memfs')).File.prototype, 'text');
  await expect(readBackupFile('mem://cache/picked/movie.mp4', MAX_BACKUP_BYTES + 1)).rejects.toBeInstanceOf(BackupTooBig);
  expect(text).not.toHaveBeenCalled();
});

it('the backup’s reading place comes back even if the book is opened (and closed) before its marks are placed', async () => {
  const old = require('./oldBook') as typeof import('./oldBook');
  const { fingerprintOf } = require('@/lib/fingerprint') as typeof import('@/lib/fingerprint');
  const fp = fingerprintOf({ size: old.EPUB.length, read: (o: number, n: number) => old.EPUB.slice(o, o + n) });
  memfs.resetDisk();
  jest.resetModules();
  const a = app();
  // A backup made before this update (converter version 1): the place is paragraph 30.
  const parsed = a.backup.parseBackup(
    JSON.stringify({
      kind: 'nec-reader-backup',
      version: 1,
      createdAt: 1000,
      build: 30,
      settings: {},
      collections: [],
      days: {},
      books: [{ fp, title: 'The Sea', author: '', engine: 1, position: { b: old.OLD_FIRST + 30, o: 0 }, percent: 0.75, openedAt: 5000, collections: [], annotations: { highlights: [], bookmarks: [] } }],
    }),
  )!;
  expect(a.backup.restoreBackup(parsed).waiting).toEqual(['The Sea']);
  // The file is added and opened at once ("Open with"), before its marks are placed.
  memfs.putFile('mem://cache/picked/sea.epub', old.EPUB);
  (require('expo-document-picker').getDocumentAsync as jest.Mock).mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'mem://cache/picked/sea.epub', name: 'sea.epub', size: old.EPUB.length }],
  });
  expect((await a.library.importBooks()).added).toBe(1);
  const id = a.library.getBooks()[0].id;
  a.library.setBookOpen(id, true);
  expect(a.library.getBook(id)?.marksWaiting).toBe(true);
  await waitFor(() => expect(a.library.getBook(id)?.status).toBe('ready'), { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 200));
  // Still open: the backup's marks wait (the reader saves where it is when it's closed).
  expect(a.library.getBook(id)?.marksWaiting).toBe(true);
  // What the reader does when it's closed: saves the place shown (the start), with openedAt now.
  a.library.updateBook(id, { position: { b: 0, o: 0 }, percent: 0, openedAt: Date.now() });
  a.library.setBookOpen(id, false);
  await waitFor(() => expect(a.library.getBook(id)?.marksWaiting).toBeFalsy(), { timeout: 15000 });
  const book = a.library.getBook(id)!;
  expect(book.percent ?? 0).toBeGreaterThan(0.5);
  expect(book.position!.b).toBe(1 + 30);
  a.library.flushLibrary();
}, 30000);

it('restoring onto a full phone: says what couldn’t be kept instead of stopping half way (or closing the app)', async () => {
  const old = require('./oldBook') as typeof import('./oldBook');
  const { fingerprintOf } = require('@/lib/fingerprint') as typeof import('@/lib/fingerprint');
  const fp = fingerprintOf({ size: old.EPUB.length, read: (o: number, n: number) => old.EPUB.slice(o, o + n) });
  // (On today's converter: not converted again under the test.)
  const { ENGINE_VERSION } = require('@/engine/types') as typeof import('@/engine/types');
  old.oldBook({ engine: ENGINE_VERSION, fp });
  jest.resetModules();
  const a = app();
  await new Promise((r) => setTimeout(r, 50));
  const s = old.para(30).indexOf('island');
  const parsed = a.backup.parseBackup(
    JSON.stringify({
      kind: 'nec-reader-backup',
      version: 1,
      createdAt: 1,
      build: 30,
      settings: { fontSize: 25 },
      collections: [],
      days: {},
      books: [
        {
          fp,
          title: 'The Sea',
          author: '',
          engine: 1,
          collections: [],
          annotations: { highlights: [{ id: 'other-phone', b: old.OLD_FIRST + 30, s, e: s + 6, color: 'blue', text: 'island', createdAt: 9 }], bookmarks: [] },
        },
      ],
    }),
  )!;
  memfs.setFreeSpace(0);
  let result: import('@/lib/backup').RestoreResult | undefined;
  try {
    result = a.backup.restoreBackup(parsed);
  } finally {
    memfs.setFreeSpace(undefined);
  }
  expect(result).toMatchObject({ applied: 0, failed: ['The Sea'] });
  // The Restore button says so.
  const alert = jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(() => {});
  memfs.putFile('mem://cache/picked/backup.json', strToU8(JSON.stringify(parsed)));
  (require('expo-document-picker').getDocumentAsync as jest.Mock).mockResolvedValue({ canceled: false, assets: [{ uri: 'mem://cache/picked/backup.json', name: 'backup.json', size: 100 }] });
  const dialogs = require('@/ui/backupDialogs') as typeof import('@/ui/backupDialogs');
  await dialogs.restoreFromFile();
  const restore = (alert.mock.calls[0][2] as { text: string; onPress?: () => void }[]).find((x) => x.text === 'Restore')!;
  memfs.setFreeSpace(0);
  try {
    expect(() => restore.onPress!()).not.toThrow();
  } finally {
    memfs.setFreeSpace(undefined);
  }
  expect(alert.mock.calls[alert.mock.calls.length - 1][0]).toBe('Not everything was restored');
  a.library.flushLibrary();
});

// ---------- what a picked file can't do, and what the person is told ----------

it('a backup can’t bring in a sort or a colour every object has ("constructor"): left out', () => {
  memfs.resetDisk();
  jest.resetModules();
  const a = app();
  const b = a.backup.parseBackup(
    JSON.stringify({
      kind: 'nec-reader-backup',
      version: 1,
      sort: 'constructor',
      view: 'list',
      books: [
        {
          fp: '1:a:b',
          title: 'Ok',
          annotations: {
            highlights: [
              { id: 'h1', b: 1, s: 0, e: 4, color: 'constructor', text: 'Call' },
              { id: 'h2', b: 1, s: 0, e: 4, color: 'toString', text: 'Call' },
              { id: 'h3', b: 1, s: 0, e: 4, color: 'pink', text: 'Call' },
            ],
          },
        },
      ],
    }),
  )!;
  expect(b.sort).toBeUndefined();
  expect(b.view).toBe('list');
  expect(b.books[0].annotations.highlights.map((h) => h.id)).toEqual(['h3']);
});

it('shelves.json with a sort or view this version doesn’t have opens the library with the usual ones', () => {
  memfs.resetDisk();
  memfs.putFile('mem://doc/shelves.json', strToU8(JSON.stringify({ sort: 'constructor', view: 'sideways', collections: [{ id: 'c1', name: 'Sea' }, null, { id: 5 }] })));
  jest.resetModules();
  const { getShelves, sortBooks } = require('@/lib/collections') as typeof import('@/lib/collections');
  expect(getShelves()).toEqual({ sort: 'recent', view: 'grid', collections: [{ id: 'c1', name: 'Sea' }] });
  // A sort it doesn't know keeps the books in the order they are, rather than losing them.
  const books = [{ id: 'x', title: 'X', author: '' }] as import('@/lib/library').BookEntry[];
  expect(sortBooks(books, 'constructor' as never)).toEqual(books);
});

it('a book whose file is gone (and was never fingerprinted) isn’t silently left out of a backup: it says which', async () => {
  const old = require('./oldBook') as typeof import('./oldBook');
  const { ENGINE_VERSION } = require('@/engine/types') as typeof import('@/engine/types');
  old.oldBook({ engine: ENGINE_VERSION });
  memfs.disk.delete(`${old.dir}/source.epub`);
  jest.resetModules();
  const a = app();
  const made = await a.backup.createBackupReport();
  expect(made.skipped).toEqual(['The Sea']);
  expect(made.backup.books).toEqual([]);
  const sharing = require('expo-sharing') as { shareAsync: jest.Mock };
  const alert = jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(() => {});
  try {
    await (require('@/ui/backupDialogs') as typeof import('@/ui/backupDialogs')).backUp();
    expect(sharing.shareAsync).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith('1 book isn’t in the backup', expect.stringContaining('The Sea'));
  } finally {
    alert.mockRestore();
    a.library.flushLibrary();
  }
});

it('a backup is never sent as message text, and a backup that can’t be shared says so', async () => {
  memfs.resetDisk();
  jest.resetModules();
  app();
  const sharing = require('expo-sharing') as { isAvailableAsync: jest.Mock; shareAsync: jest.Mock };
  const RN = require('react-native') as typeof import('react-native');
  const share = jest.spyOn(RN.Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
  const alert = jest.spyOn(RN.Alert, 'alert').mockImplementation(() => {});
  try {
    const dialogs = require('@/ui/backupDialogs') as typeof import('@/ui/backupDialogs');
    sharing.shareAsync.mockRejectedValueOnce(new Error('No Activity found to handle Intent'));
    await expect(dialogs.backUp()).resolves.toBeUndefined();
    sharing.isAvailableAsync.mockResolvedValueOnce(false);
    await dialogs.backUp();
    expect(share).not.toHaveBeenCalled();
    expect(alert.mock.calls.map((c) => c[0])).toEqual(['Couldn’t make the backup', 'Couldn’t make the backup']);
  } finally {
    share.mockRestore();
    alert.mockRestore();
  }
});

it('a file picker that fails to open says so instead of failing silently', async () => {
  memfs.resetDisk();
  jest.resetModules();
  app();
  (require('expo-document-picker').getDocumentAsync as jest.Mock).mockRejectedValueOnce(new Error('Different document picking in progress'));
  const alert = jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(() => {});
  try {
    await expect((require('@/ui/backupDialogs') as typeof import('@/ui/backupDialogs')).restoreFromFile()).resolves.toBeUndefined();
    expect(alert).toHaveBeenCalledWith('Couldn’t open the file picker', expect.any(String));
  } finally {
    alert.mockRestore();
  }
});
