/// <reference types="jest" />
// End to end through the real code, with only the file system and the
// document picker replaced: add an EPUB from the picker, let it be prepared,
// read a few pages, highlight a word, close the book and "kill" the app
// (every module's memory is dropped; only the files stay), then open the app
// and the book again: it opens on the same page with the highlight there.

import { strToU8, zipSync } from 'fflate';

jest.mock('expo-file-system', () => require('./memfs'));
jest.unmock('@/lib/storage');
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: (globalThis as { __bookId?: string }).__bookId }),
  router: { back: jest.fn(), push: jest.fn() },
}));
jest.mock('expo-screen-orientation', () => ({ lockAsync: () => Promise.resolve(), OrientationLock: {} }));

const para = (i: number) => `Paragraph ${i}. ` + 'The sea was calm and the sky was wide, and the ship went on through the night. '.repeat(4);

function epub() {
  const body = Array.from({ length: 40 }, (_, i) => `<p>${para(i)}</p>`).join('');
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OEBPS/c.opf"/></rootfiles></container>'),
    'OEBPS/c.opf': strToU8(
      '<package><metadata><dc:title>The Sea</dc:title><dc:creator>A. Sailor</dc:creator></metadata>' +
        '<manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>',
    ),
    'OEBPS/a.xhtml': strToU8(`<html><body><h1>Chapter One</h1>${body}</body></html>`),
  });
}

/** Load the app's modules as a fresh start would (after resetModules). */
function app() {
  const rtl = require('@testing-library/react-native/pure') as typeof import('@testing-library/react-native');
  const RN = require('react-native') as typeof import('react-native');
  // Capture AppState listeners, to send the app to the background like the OS does.
  const appState: ((s: string) => void)[] = [];
  jest.spyOn(RN.AppState, 'addEventListener').mockImplementation((_t, l) => {
    appState.push(l as (s: string) => void);
    return { remove: () => appState.splice(appState.indexOf(l as (s: string) => void), 1) } as never;
  });
  require('@/app/_layout'); // what the app does at start: loads the library, listens for background
  return {
    ...rtl,
    W: RN.Dimensions.get('window').width,
    library: require('@/lib/library') as typeof import('@/lib/library'),
    annotations: require('@/lib/annotations') as typeof import('@/lib/annotations'),
    settings: require('@/lib/settings') as typeof import('@/lib/settings'),
    Reader: (require('@/app/reader/[id]') as typeof import('@/app/reader/[id]')).default,
    background: () => [...appState].forEach((l) => l('background')),
  };
}

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));


it('import → read → highlight → app killed → reopened on the same page with the highlight', async () => {
  const memfs = require('./memfs') as typeof import('./memfs');
  memfs.resetDisk();
  memfs.putFile('mem://cache/DocumentPicker/the-sea.epub', epub());
  (require('expo-document-picker').getDocumentAsync as jest.Mock).mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'mem://cache/DocumentPicker/the-sea.epub', name: 'the-sea.epub', size: epub().length }],
  });

  // ---- first run: import and read ----
  let a = app();
  a.settings.setSettings({ mode: 'page', seenTapZones: true, pageTurn: 'none', hyphenate: false, indent: false, align: 'left' });
  const res = await a.library.importBooks();
  expect(res.added).toBe(1);
  const id = (JSON.parse(new memfs.File("mem://doc/library.json").textSync()) as { id: string }[])[0].id;
  (globalThis as { __bookId?: string }).__bookId = id;
  await a.waitFor(() => expect(a.library.getBook(id)?.status).toBe('ready'), { timeout: 10000 });
  expect(a.library.getBook(id)?.title).toBe('The Sea');

  let view = await a.render(<a.Reader />);
  // The page in the WebView (test/ui/fakePage.ts) shows the first page.
  const page = () => (globalThis as { __page?: import('./fakePage').FakePage }).__page!;
  await a.waitFor(() => expect(view.getByText(/^1 of \d+ · /)).toBeTruthy(), { timeout: 9000 });
  // Turn the page twice, as a tap on the right edge does on the page.
  for (const n of [2, 3]) {
    await a.act(() => page().turn(1));
    await a.waitFor(() => expect(view.getByText(new RegExp(`^${n} of \\d+ · `))).toBeTruthy(), { timeout: 8000 });
  }
  const footer = view.getByText(/^3 of \d+ · /).props.children as string;
  const pageNo = footer.split(' · ')[0];

  // Highlight tool: pick a colour, tap a word on this page: it's highlighted.
  await a.act(() => page().emit({ t: 'tap' }));
  await a.fireEvent.press(view.getByLabelText('Highlight'));
  await a.fireEvent.press(view.getByLabelText('Highlight colour green'));
  const on = page().shown().first;
  await a.act(() => page().emit({ t: 'markTap', at: { b: on.b, i: on.i + 3 } }));
  const made = a.annotations.getAnnotations(id).highlights;
  expect(made).toHaveLength(1);
  const word = made[0].text;
  expect(word.length).toBeGreaterThan(0);
  await a.fireEvent.press(view.getByLabelText('Done highlighting'));

  // Leave the book, the OS sends the app to the background, then kills it.
  await view.unmount(); // leaving the book saves where reading stopped
  const position = a.library.getBook(id)!.position!;
  expect(position.b).toBeGreaterThan(0);
  a.background();
  await flushMicrotasks();
  const savedPos = (JSON.parse(new memfs.File('mem://doc/library.json').textSync()) as { id: string; position: unknown }[]).find((b) => b.id === id)!.position;
  expect(savedPos).toEqual(position);
  expect(memfs.disk.has(`mem://doc/books/${id}/annotations.json`)).toBe(true);

  // ---- the app starts again from what is on disk ----
  jest.resetModules();
  a = app();
  expect(a.library.getBook(id)?.position).toEqual(position);
  expect(a.annotations.getAnnotations(id).highlights.map((h) => h.text)).toEqual([word]);
  a.settings.setSettings({ seenTapZones: true });
  view = await a.render(<a.Reader />);
  await a.waitFor(() => expect(view.getByText(new RegExp(`^${pageNo} · `))).toBeTruthy(), { timeout: 9000 });
  // The highlight is drawn on the page.
  await a.waitFor(() => expect(page().marks.some((m) => m.b === made[0].b)).toBe(true));
  await view.unmount();
}, 90000);
