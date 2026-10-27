/// <reference types="jest" />
// A book whose conversion keeps killing the app is marked as failed, but
// Android killing the app in the background while it converts a big book
// is not the book's fault and must not count.

/** What's saved on disk, kept across simulated restarts: file uri -> JSON. */
const mockDisk = new Map<string, string>();

jest.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/');
    }
    /** Only the book's own file is on disk (nothing converted yet). */
    get exists() {
      return this.uri.endsWith('/source.epub');
    }
    name = 'source.epub';
  }
  class Directory extends File {
    delete() {}
  }
  return { File, Directory, Paths: { document: 'doc' } };
});
jest.mock('@/lib/storage', () => {
  const { Directory, File } = require('expo-file-system');
  return {
    readJson: (f: { uri: string }) => (mockDisk.has(f.uri) ? JSON.parse(mockDisk.get(f.uri)!) : null),
    writeJson: () => {},
    saveJson: (f: { uri: string }, v: unknown) => mockDisk.set(f.uri, JSON.stringify(v)),
    removeJson: () => {},
    bookDir: (id: string) => new Directory(`doc/books/${id}`),
    nextDir: (id: string) => new Directory(`doc/books/${id}/next`),
    booksDir: () => ({ list: () => [] }),
    ensureDir: () => {},
    imageFile: () => ({ exists: false, uri: '' }),
    manifestFile: (id: string) => new File(`doc/books/${id}/manifest.json`),
    FileSink: class {},
    FileSource: class {
      size = 1;
      read() {
        return new Uint8Array(0);
      }
      close() {}
    },
  };
});
jest.mock('expo-document-picker', () => ({}));
// Converting never finishes: every "launch" ends with the app being killed mid-conversion.
jest.mock('@/engine/ingest', () => ({
  ...jest.requireActual('@/engine/ingest'),
  ingestBook: () => new Promise(() => {}),
}));

type Library = typeof import('@/lib/library');

/** Start the app afresh (new JS context, same disk), in the foreground or not. */
function launch(state: 'active' | 'background' = 'active') {
  // A fresh module registry: the library's state is gone, the disk isn't.
  jest.resetModules();
  const { AppState } = require('react-native');
  Object.defineProperty(AppState, 'currentState', { value: state, writable: true, configurable: true });
  let onChange: (s: string) => void = () => {};
  jest.spyOn(AppState, 'addEventListener').mockImplementation((...a: unknown[]) => {
    onChange = a[1] as (s: string) => void;
    return { remove() {} };
  });
  const lib: Library = require('@/lib/library');
  lib.loadLibrary();
  return {
    lib,
    book: () => lib.getBook('big')!,
    saved: () => (JSON.parse(mockDisk.get('doc/library.json')!) as { attempts?: number; status: string }[])[0],
    goTo: (s: 'active' | 'background') => {
      AppState.currentState = s;
      onChange(s);
    },
  };
}

const bigBook = { id: 'big', title: 'Big', author: '', fileName: 'big.epub', sourceName: 'source.epub', size: 1, addedAt: 0, openedAt: 0, status: 'processing', progress: 0 };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  mockDisk.clear();
  mockDisk.set('doc/library.json', JSON.stringify([bigBook]));
});

it('being killed in the background, again and again, does not mark the book as damaged', async () => {
  for (let i = 0; i < 4; i++) {
    const app = launch();
    await flush();
    expect(app.saved().attempts).toBe(1); // counted on disk while converting in the foreground
    app.goTo('background');
    expect(app.saved().attempts).toBe(0); // taken back: a kill from here on is not the book's fault
  }
  const app = launch();
  expect(app.book().status).toBe('processing');
});

it('coming back to the foreground counts the attempt again', async () => {
  let app = launch();
  await flush();
  app.goTo('background');
  app.goTo('active');
  expect(app.saved().attempts).toBe(1);
  // Killed in the foreground twice: the book is what stops the app.
  app = launch();
  await flush();
  app = launch();
  expect(app.book().status).toBe('error');
  expect(app.book().error).toMatch(/stopped the app/);
});

it('a conversion started in the background is counted once the app is in front', async () => {
  const app = launch('background');
  await flush();
  expect(app.saved().attempts ?? 0).toBe(0);
  app.goTo('active');
  expect(app.saved().attempts).toBe(1);
});

it('crashing in the foreground twice marks the book as failed; Try again starts over', async () => {
  launch();
  await flush();
  launch();
  await flush();
  const app = launch();
  expect(app.book()).toMatchObject({ status: 'error', attempts: 2 });
  app.lib.reprocessBook('big');
  expect(app.book()).toMatchObject({ status: 'processing', error: undefined });
  await flush();
  expect(app.saved().attempts).toBe(1);
});

it('internal error messages saved by older versions are shown as a plain sentence', async () => {
  mockDisk.set('doc/library.json', JSON.stringify([{ ...bigBook, status: 'error', error: "TypeError: Cannot read property 'x' of undefined" }]));
  const app = launch();
  expect(app.book().error).not.toMatch(/TypeError|undefined/);
  expect(app.book().error).toMatch(/couldn’t be prepared/);
});
