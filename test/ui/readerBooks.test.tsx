/// <reference types="jest" />
// The reader screen with books of unusual shapes: a book of a page a chunk
// (poems, pictures), an illustrated book still being converted, one with a
// damaged chunk far away, chunks loading slowly while the reader turns back
// and forth, a long paragraph stored in parts, a long chapter cut in two for
// size, and a phone turned on its side. Each test gives the screen its own
// book (mockState.book).

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { Dimensions, Image } from 'react-native';
import type { Block, Manifest } from '@/engine/types';
import { setSettings } from '@/lib/settings';
import ReaderScreen from '@/app/reader/[id]';
import { BookData } from '@/reader/book';
import type { ToPage } from '@/reader/web/protocol';
import { FakePage } from './fakePage';

interface TestBook {
  entry: { id: string; title: string; author: string; status: 'ready' | 'processing'; format: string; position: { b: number; o: number }; lang?: string };
  manifest: Manifest | null;
  live?: { chunks: [number, number][]; weights?: number[]; totalBlocks: number; totalChars: number; progress: number };
}
/** The book the screen opens, and its listeners (a conversion finishing). */
export const mockState: { book: TestBook; listeners: Set<() => void> } = { book: null as unknown as TestBook, listeners: new Set() };
/** Page sizes the reader keeps with the book: [book id, layout key, size]. */
export const mockSaved: [string, string, number][] = [];

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: require('./readerBooks.test').mockState.book.entry.id }), router: { back: jest.fn() } }));
jest.mock('expo-screen-orientation', () => ({ lockAsync: () => Promise.resolve(), OrientationLock: {} }));
jest.mock('@/lib/library', () => {
  const st = () => require('./readerBooks.test').mockState;
  const use = <T,>(get: () => T): T =>
    require('react').useSyncExternalStore((l: () => void) => {
      st().listeners.add(l);
      return () => st().listeners.delete(l);
    }, get);
  return {
    getBook: () => st().book.entry,
    loadManifest: () => (st().book.entry.status === 'ready' ? st().book.manifest : null),
    useBookStatus: () => use(() => st().book.entry.status),
    useLiveBook: () => use(() => st().book.live),
    updateBook: () => {},
    reprocessBook: () => {},
    setBookOpen: () => {},
    sourceFile: () => ({}),
  };
});
jest.mock('@/reader/pageStore', () => ({
  loadPageSizes: () => new Map(),
  savePageSizes: (id: string, sizes: Map<string, number>) => {
    const saved = require('./readerBooks.test').mockSaved as [string, string, number][];
    for (const [k, v] of sizes) if (!saved.some(([i, key]) => i === id && key === k)) saved.push([id, k, v]);
  },
}));
// Insets that change as the system bars hide and show, and as the phone turns.
const mockInsets = { now: { top: 0, bottom: 0, left: 0, right: 0 }, listeners: new Set<() => void>() };
function setInsets(i: Partial<typeof mockInsets.now>) {
  mockInsets.now = { ...mockInsets.now, ...i };
  mockInsets.listeners.forEach((l) => l());
}
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context/jest/mock').default;
  return {
    ...actual,
    useSafeAreaInsets: () =>
      require('react').useSyncExternalStore(
        (l: () => void) => {
          mockInsets.listeners.add(l);
          return () => mockInsets.listeners.delete(l);
        },
        () => mockInsets.now,
      ),
  };
});

const page = () => (globalThis as { __page?: FakePage }).__page!;
const wait = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));
const turn = (dir: 1 | -1) =>
  act(async () => {
    page().turn(dir);
    await page().settled();
  });
const sent = <T extends ToPage['t']>(t: T) => page().sent.filter((m): m is Extract<ToPage, { t: T }> => m.t === t);
const footer = () => screen.getByText(/^\d+(–\d+)? of ~?\d+ · /).props.children as string;
const shownNumber = () => Number(/^(\d+)/.exec(footer())![1]);
const window0 = Dimensions.get('window');

/** A book of chunks of blocks (and, while converting, only the first `converted` of them so far). */
function book(id: string, chunks: Block[][], o: { weights?: number[]; converted?: number; images?: Manifest['images']; format?: string; position?: { b: number; o: number } } = {}): TestBook {
  const len = (b: Block) => (b.r ? Math.max(1, b.r.map((r) => (typeof r === 'string' ? r : r[0])).join('').length) : 1);
  const starts: [number, number][] = [];
  let blocks = 0;
  let chars = 0;
  for (const ch of chunks) {
    starts.push([blocks, chars]);
    blocks += ch.length;
    chars += ch.reduce((n, b) => n + len(b), 0);
  }
  const st = require('@/lib/storage').testChunks as Map<string, string>;
  chunks.forEach((ch, c) => st.set(`${id}/${c}`, JSON.stringify({ b: ch })));
  const manifest: Manifest = { v: 2, format: (o.format ?? 'txt') as Manifest['format'], title: id, author: '', totalBlocks: blocks, totalChars: chars, chunks: starts, weights: o.weights, toc: [], images: o.images ?? {}, lang: 'en' };
  const entry = { id, title: id, author: '', status: (o.converted === undefined ? 'ready' : 'processing') as 'ready' | 'processing', format: o.format ?? 'txt', position: o.position ?? { b: 0, o: 0 }, lang: 'en' };
  if (o.converted === undefined) return { entry, manifest };
  const n = o.converted;
  const live = { chunks: starts.slice(0, n), weights: o.weights?.slice(0, n), totalBlocks: starts[n]?.[0] ?? blocks, totalChars: starts[n]?.[1] ?? chars, progress: n / chunks.length };
  return { entry, manifest, live };
}

async function open(b: TestBook) {
  mockState.book = b;
  await render(<ReaderScreen />);
  await waitFor(() => expect(page().shown()).toBeTruthy(), { timeout: 5000 });
  await act(() => page().settled());
  await wait(30);
}

beforeEach(() => {
  setSettings({ mode: 'page', fontSize: 19, indent: false, hyphenate: false, align: 'left', pageTurn: 'none', seenTapZones: true });
  mockInsets.now = { top: 0, bottom: 0, left: 0, right: 0 };
  FakePage.pageSize = () => 400;
  mockSaved.length = 0;
});
afterEach(() => {
  Dimensions.set({ window: window0, screen: window0 });
  jest.restoreAllMocks();
});

describe('measuring the page size of a layout', () => {
  it('chunks too small to measure (a page each: poems, pictures) are measured once, not again on every page turn', async () => {
    const poem = (n: number): Block[] => [{ k: 'p', r: [`Poem ${n}. The sea was calm and the sky was wide tonight, and the moon was low.`] }];
    await open(book('poems', Array.from({ length: 30 }, (_, c) => poem(c)), { weights: Array.from({ length: 30 }, () => 4), format: 'epub', position: { b: 5, o: 0 } }));
    const afterOpen = sent('measure').length;
    for (let k = 0; k < 10; k++) {
      await turn(1);
      await wait(20);
    }
    expect(sent('measure').length - afterOpen).toBe(0);
    // A page size was kept for the layout all the same.
    expect(mockSaved.some(([id]) => id === 'poems')).toBe(true);
  }, 30000);

  it("while converting, a layout isn't measured (for good) on chunks drawn without their pictures; once complete, it is", async () => {
    jest.spyOn(Image, 'getSize').mockImplementation((_uri, ok) => ok(600, 800));
    // A picture at the start of every chapter (an illustrated FB2: its pictures come at the end of the file).
    const chapter = (c: number): Block[] => [{ k: 'img', s: `pic${c}.jpg` }, ...Array.from({ length: 9 }, (_, n): Block => ({ k: 'p', r: [`Block ${c}.${n}. `.padEnd(400, 'x')] }))];
    const chunks = Array.from({ length: 12 }, (_, c) => chapter(c));
    const images = Object.fromEntries(chunks.map((_, c) => [`pic${c}.jpg`, { file: `b_pic${c}.jpg` }]));
    const b = book('ill', chunks, { weights: chunks.map(() => 200), converted: 10, images, format: 'fb2' });
    await open(b);
    await wait(100);
    expect(mockSaved).toEqual([]);
    // The conversion finishes: the pictures are there; the layout is measured with them, and kept.
    await act(async () => {
      b.entry.status = 'ready';
      b.live = undefined;
      mockState.listeners.forEach((l) => l());
    });
    await act(() => page().settled());
    await wait(100);
    await act(() => page().settled());
    expect(mockSaved.some(([id]) => id === 'ill')).toBe(true);
    const asked = sent('measure').at(-1)!;
    expect(asked.chunks.every((ch) => ch.html.includes('width="600" height="800"'))).toBe(true);
  }, 30000);

  it("a damaged chunk far from the place read doesn't stop the book opening; the layout is measured on what's laid out", async () => {
    const para = (n: number) => `Paragraph ${n}. The sea was calm and the sky was wide.`.padEnd(390, ' On.').slice(0, 390);
    const chunks = Array.from({ length: 20 }, (_, c) => Array.from({ length: 4 + (c % 3) }, (_, n): Block => ({ k: 'p', r: [para(c * 10 + n)] })));
    const b = book('dmg', chunks);
    // Lost or damaged on the phone.
    (require('@/lib/storage').testChunks as Map<string, string>).delete('dmg/10');
    await open(b);
    await wait(200);
    expect(screen.queryByText("This book couldn't be opened")).toBeNull();
    expect(page().shown()).toBeTruthy();
  }, 30000);
});

describe('chunks loading while the reader turns back and forth', () => {
  // One short paragraph a chunk (front matter, short poems): a page a chunk.
  const pieces = () => book('pieces', Array.from({ length: 12 }, (_, c) => [{ k: 'p', r: [`Piece ${c}. The sea was calm and the sky was wide.`] } as Block]), { format: 'epub', position: { b: 6, o: 0 } });
  /** Chunk 8 is slow to read (a big chapter, pictures to measure). */
  function slowEight() {
    const read = BookData.prototype.loadChunk;
    return jest.spyOn(BookData.prototype, 'loadChunk').mockImplementation(function (this: BookData, i: number) {
      const p = read.call(this, i);
      return i === 8 ? p.then((b) => new Promise((r) => setTimeout(() => r(b), 400))) : p;
    });
  }

  it("a chunk read back from while it was loading isn't added after all: the page holds no chunk the screen doesn't know of", async () => {
    await open(pieces());
    expect(page().shown().c).toBe(6);
    const slow = slowEight();
    await turn(1); // chunk 7: the screen asks for chunk 8 (slow)
    await turn(-1); // 6
    await turn(-1); // 5: chunk 8 is far now, dropped (before it ever reached the page)
    await wait(30);
    await turn(-1); // 4
    await wait(500);
    await act(() => page().settled());
    slow.mockRestore();
    const onPage = [...page().chunks.keys()].sort((a, b) => a - b);
    expect(onPage).toEqual(Array.from({ length: onPage.length }, (_, k) => onPage[0] + k));
    // Reading on through them: none skipped.
    await turn(1);
    await wait(30);
    await act(async () => {
      page().turn(1);
      page().turn(1);
      await page().settled();
    });
    expect([6, 7]).toContain(page().shown().c);
  }, 30000);
});

it('copying across the cut in a long paragraph (stored in two parts) copies the characters as they read', async () => {
  const first = 'It was a long sentence that went on and on across the cut ';
  const second = 'and kept going until the very end of the paragraph.';
  await open(book('cut', [[{ k: 'p', r: [first] }, { k: 'p', c: 1, r: [second] }, { k: 'p', r: ['A new paragraph.'] }]]));
  const copy = jest.spyOn(Clipboard, 'setStringAsync');
  const s = first.indexOf('across');
  const e = second.indexOf('going') + 'going'.length;
  await act(() => page().emit({ t: 'selection', start: { b: 0, i: s }, end: { b: 1, i: e }, startCaret: { x: 20, y: 70, h: 28 }, endCaret: { x: 80, y: 98, h: 28 } }));
  await fireEvent.press(screen.getByLabelText('Copy'));
  expect(copy).toHaveBeenLastCalledWith('across the cut and kept going');
  // And into the next paragraph: on a line of its own.
  await act(() => page().emit({ t: 'selection', start: { b: 1, i: second.indexOf('paragraph') }, end: { b: 2, i: 5 }, startCaret: { x: 20, y: 70, h: 28 }, endCaret: { x: 80, y: 98, h: 28 } }));
  await fireEvent.press(screen.getByLabelText('Copy'));
  expect(copy).toHaveBeenLastCalledWith('paragraph.\nA new');
}, 30000);

it('a chapter cut in two for size reads on as one: page numbers go one by one across the cut', async () => {
  FakePage.pageSize = () => 380;
  const block = (n: number): Block => ({ k: 'p', r: [`Block ${n}. `.padEnd(400, 'x')] });
  // The chapter's first chunk was cut at the converter's size (30,000 characters); the second goes on from it.
  const chunks = [
    Array.from({ length: 76 }, (_, n) => block(n)),
    Array.from({ length: 10 }, (_, n) => block(100 + n)),
    ...Array.from({ length: 6 }, (_, c) => Array.from({ length: 12 }, (_, n) => block(200 + c * 20 + n))),
  ];
  await open(book('long', chunks, { position: { b: 70, o: 0 } }));
  expect(page().sent.some((m) => m.t === 'content' && m.chunks.some((ch) => ch.c === 1 && ch.joins))).toBe(true);
  const seen = [shownNumber()];
  const at = () => `${page().shown().first.b}:${page().shown().first.i}`;
  for (let k = 0; k < 16; k++) {
    const from = at();
    for (let tries = 0; tries < 5 && at() === from; tries++) {
      await turn(1);
      await wait(20);
    }
    seen.push(shownNumber());
  }
  // Through the end of the first chunk, the page it shares with the second, and on.
  expect(page().shown().c).toBe(1);
  for (let k = 1; k < seen.length; k++) expect(seen[k]).toBe(seen[k - 1] + 1);
}, 30000);

it('turned on its side: the page size is kept only for the layout the reader settles in, not for one laid out while the insets arrive', async () => {
  const para = (n: number) => `Paragraph ${n}. The sea was calm and the sky was wide.`.padEnd(390, ' On.').slice(0, 390);
  const chunks = Array.from({ length: 10 }, (_, c) => Array.from({ length: 8 + (c % 3) }, (_, n): Block => ({ k: 'p', r: [para(c * 20 + n)] })));
  await open(book('turned', chunks));
  await act(() => page().settled());
  await wait(400);
  const before = mockSaved.filter(([id]) => id === 'turned').length;
  // Turned: the window first, the notch's insets a moment after.
  const landscape = { width: 844, height: 390, scale: 3, fontScale: 1 };
  await act(async () => Dimensions.set({ window: landscape, screen: landscape }));
  await act(() => page().settled());
  await wait(100);
  await act(async () => setInsets({ left: 47, right: 47, bottom: 21 }));
  await wait(600);
  await act(() => page().settled());
  await wait(100);
  const kept = mockSaved.filter(([id]) => id === 'turned').slice(before);
  expect(kept).toHaveLength(1);
  // …for the frame with the notch's insets (47 and the margin each side), not the one without.
  expect(kept[0][1]).toContain('|844|');
  expect(kept[0][1]).not.toMatch(/\|20\|20\|/);
}, 30000);
