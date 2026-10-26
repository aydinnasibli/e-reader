/// <reference types="jest" />
// Page numbers on the real reader screen, in a book of many chapters of many
// lengths whose pages hold different amounts of text (as real chapters do:
// dialogue, headings, pictures): going to page N lands on page N, numbers
// never go back while reading on, the total stays put, each layout keeps its
// own numbers (with the book), and the slider and the Back chip say the same
// numbers the footer does.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Dimensions } from 'react-native';
import type { Block, Manifest } from '@/engine/types';
import { setSettings } from '@/lib/settings';
import ReaderScreen from '@/app/reader/[id]';
import { FakePage } from './fakePage';

const CHUNKS = 30;
const BLOCK = 390;
const text = (n: number) => `Block ${n}. `.padEnd(BLOCK, 'x');
// Chapters of 7 to 12 paragraphs: their last pages are part full, as real ones are.
const sizes = Array.from({ length: CHUNKS }, (_, c) => 7 + ((c * 7) % 6));
const firstBlock = (c: number) => sizes.slice(0, c).reduce((a, b) => a + b, 0);
const blocks: Block[] = Array.from({ length: firstBlock(CHUNKS) }, (_, n) => ({ k: 'p', r: [text(n)] }));
/** Characters a page of chunk `c` holds: chunks 0-2 have shorter lines than the rest (10% less a page). */
const perPage = (c: number) => (c < 3 ? 360 : 400);
/** The converter's weights: the lines each chunk takes (twenty to a page), so it knows short lines take more room. */
const weights = sizes.map((n, c) => Math.round((20 * n * BLOCK) / perPage(c)));
const manifest: Manifest = {
  v: 2,
  format: 'txt',
  title: 'Long',
  author: '',
  totalBlocks: blocks.length,
  totalChars: blocks.length * BLOCK,
  chunks: Array.from({ length: CHUNKS }, (_, c) => [firstBlock(c), firstBlock(c) * BLOCK] as [number, number]),
  weights,
  toc: Array.from({ length: CHUNKS }, (_, c) => ({ t: `Chapter ${c + 1}`, l: 0, b: firstBlock(c) })),
  images: {},
};
export const manifestForMock = manifest;
/** The book entry (tests change its saved place). */
export const entryForMock = { id: 'long', title: 'Long', author: '', status: 'ready', format: 'txt', position: { b: 0, o: 0 } };
const mockSaved = new Map<string, unknown>();

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'long' }), router: { back: jest.fn() } }));
jest.mock('expo-screen-orientation', () => ({ lockAsync: () => Promise.resolve(), OrientationLock: {} }));
jest.mock('@/lib/library', () => ({
  getBook: () => require('./pageNumbers.test').entryForMock,
  loadManifest: () => require('./pageNumbers.test').manifestForMock,
  useBookStatus: () => 'ready',
  useLiveBook: () => undefined,
  updateBook: () => {},
  reprocessBook: () => {},
  setBookOpen: () => {},
  sourceFile: () => ({}),
}));
// The page sizes kept with the book (pages.json), in memory.
jest.mock('@/reader/pageStore', () => ({
  loadPageSizes: (id: string) => new Map((mockSaved.get(id) as [string, number][] | undefined) ?? []),
  savePageSizes: (id: string, sizes: Map<string, number>) => mockSaved.set(id, [...sizes]),
}));

const page = () => (globalThis as { __page?: FakePage }).__page!;
const footer = () => screen.getByText(/^\d+(–\d+)? of ~?\d+ · /).props.children as string;
const shownNumber = () => Number(/^(\d+)/.exec(footer())![1]);
const total = () => Number(/ of ~?(\d+) · /.exec(footer())![1]);
const contents = () => page().sent.filter((m) => m.t === 'content').length;
const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));
const window0 = Dimensions.get('window');

beforeAll(() => {
  const st = require('@/lib/storage').testChunks as Map<string, string>;
  for (let c = 0; c < CHUNKS; c++) st.set(`long/${c}`, JSON.stringify({ b: blocks.slice(firstBlock(c), firstBlock(c + 1)) }));
});
beforeEach(() => {
  setSettings({ mode: 'page', fontSize: 19, indent: false, hyphenate: false, align: 'left', pageTurn: 'none', seenTapZones: true });
  entryForMock.position = { b: 0, o: 0 };
  manifest.weights = weights;
  FakePage.pageSize = perPage;
  mockSaved.clear();
});
afterEach(() => {
  Dimensions.set({ window: window0, screen: window0 });
});

async function open() {
  await render(<ReaderScreen />);
  await waitFor(() => expect(footer()).toMatch(/^\d+/), { timeout: 5000 });
  await act(() => page().settled());
  await settle();
}

/** Menu → Go to page → a number → Go, and wait for the page to show it. */
async function goToPage(n: number) {
  const before = contents();
  await act(() => page().emit({ t: 'tap' }));
  await fireEvent.press(screen.getByLabelText('Go to page'));
  await fireEvent.changeText(screen.getByLabelText('Page number'), String(n));
  await fireEvent.press(screen.getByLabelText('Go'));
  await waitFor(() => expect(contents()).toBeGreaterThan(before));
  await act(() => page().settled());
  await settle();
}

/** Turn `turns` pages on (waiting for the next chunk where the page runs out), noting each footer number. */
async function readOn(turns: number) {
  const seen: number[] = [shownNumber()];
  const at = () => `${page().shown().first.b}:${page().shown().first.i}`;
  for (let k = 0; k < turns; k++) {
    const from = at();
    for (let tries = 0; tries < 5 && at() === from; tries++) {
      await act(async () => {
        page().turn(1);
        await page().settled();
      });
      await settle();
    }
    seen.push(shownNumber());
  }
  return seen;
}

it('go to page N lands on page N, far into the book, again and again', async () => {
  await open();
  const results: string[] = [];
  for (const want of [200, 37, 120, 260, 5, 199]) {
    await goToPage(want);
    const got = shownNumber();
    results.push(got === want ? `${want} ok` : `${want} -> ${got}`);
  }
  expect(results.filter((r) => !r.endsWith('ok'))).toEqual([]);
}, 60000);

it('a book converted before weights (counted in characters): jumps land on their page or a page or two before it', async () => {
  manifest.weights = undefined;
  await open();
  let exact = 0;
  let worst = 0;
  for (const want of [200, 37, 120, 260, 5, 199]) {
    await goToPage(want);
    const got = shownNumber();
    if (got === want) exact++;
    worst = Math.max(worst, Math.abs(got - want));
  }
  expect(exact).toBeGreaterThanOrEqual(4);
  expect(worst).toBeLessThanOrEqual(2);
}, 60000);

it('pages holding a few percent more or less from chunk to chunk than counted, opened mid-book: jumps land on their pages', async () => {
  let seed = 7;
  const varied = Array.from({ length: CHUNKS }, () => Math.round(400 * (1 + (((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1) * 0.05)));
  FakePage.pageSize = (c) => (perPage(c) * varied[c]) / 400;
  entryForMock.position = { b: firstBlock(10), o: 0 };
  await open();
  let exact = 0;
  let worst = 0;
  // All through the book, whatever its total came out as.
  const pages = total();
  for (const share of [0.07, 0.17, 0.27, 0.37, 0.47, 0.57, 0.67, 0.77, 0.87, 0.97]) {
    const want = Math.round(share * pages);
    await goToPage(want);
    const got = shownNumber();
    if (got === want) exact++;
    worst = Math.max(worst, Math.abs(got - want));
  }
  // A number skipped at the end of a chunk (its pages came out fewer than counted) is the only miss, by a page or two.
  expect(exact).toBeGreaterThanOrEqual(8);
  expect(worst).toBeLessThanOrEqual(2);
}, 60000);

it('reading on: the numbers never go back and the total never changes', async () => {
  await open();
  const before = total();
  const seen = await readOn(60);
  for (let k = 1; k < seen.length; k++) expect(seen[k]).toBeGreaterThanOrEqual(seen[k - 1]);
  // One by one, but for a number now and then at the end of a chapter.
  expect(seen.filter((n, k) => k > 0 && n === seen[k - 1] + 1).length).toBeGreaterThan(50);
  expect(total()).toBe(before);
}, 60000);

it("the book's last page has the last number, and going to it lands there", async () => {
  await open();
  const last = total();
  await goToPage(last);
  expect(shownNumber()).toBe(last);
  expect(page().shown().c).toBe(CHUNKS - 1);
  expect(page().last('content')!.target).toEqual({ chunk: CHUNKS - 1, edge: 'last' });
}, 60000);

it('opened at its start, a book whose first chunks take far more pages than counted (a long contents list at a big text size) is still numbered right', async () => {
  // Chunks 0-2 hold half what their weights say on a page.
  FakePage.pageSize = (c) => (c < 3 ? perPage(c) / 2 : perPage(c));
  await open();
  // Measured out of sight on chunks like the rest of the book, not on the ones around the start.
  expect(page().last('measure')!.chunks.map((ch) => ch.c).every((c) => c >= 3 && c < CHUNKS - 1)).toBe(true);
  // The first chunks' extra pages share their last numbers: the total is short by about those.
  const real = sizes.reduce((n, size, c) => n + Math.ceil((size * BLOCK) / FakePage.pageSize(c)), 0);
  expect(Math.abs(total() - real) / real).toBeLessThan(0.15);
  // And the numbers count up one by one through the middle of the book.
  await goToPage(Math.round(total() / 2));
  const seen = await readOn(30);
  expect(seen.filter((n, k) => k > 0 && n === seen[k - 1] + 1).length).toBeGreaterThanOrEqual(27);
}, 60000);

it('each layout keeps its own numbers: a setting changed and back gives the same numbers back, also when the book is opened again', async () => {
  const view = await (async () => {
    await open();
    return screen;
  })();
  await goToPage(150);
  expect(shownNumber()).toBe(150);
  const at19 = total();
  // Bigger text: the page is laid out again, with numbers of its own.
  await act(async () => setSettings({ fontSize: 26 }));
  await act(() => page().settled());
  await settle();
  // Pages hold less at the bigger size: the page counts more of them.
  FakePage.pageSize = (c) => perPage(c) * 0.72;
  await act(async () => setSettings({ fontSize: 27 }));
  await act(() => page().settled());
  await settle();
  const at27 = total();
  expect(at27).toBeGreaterThan(at19);
  FakePage.pageSize = perPage;
  await act(async () => setSettings({ fontSize: 19 }));
  await act(() => page().settled());
  await settle();
  expect(total()).toBe(at19);
  // Opened again: the same numbers at once, from what was kept with the book.
  await view.unmount();
  await open();
  expect(total()).toBe(at19);
}, 60000);

it('the slider says the page it goes to; the Back chip names the page that was shown', async () => {
  await open();
  await goToPage(90);
  const was = shownNumber();
  await act(() => page().emit({ t: 'tap' }));
  const slider = screen.getByTestId('progress-slider');
  await act(() => fireEvent(slider, 'valueChange', 0.5));
  const label = /^Page (\d+) of \d+ · /.exec(screen.getByText(/^Page \d+ of \d+ · /).props.children.join(''))!;
  const before = contents();
  await act(() => fireEvent(slider, 'slidingComplete', 0.5));
  await waitFor(() => expect(contents()).toBeGreaterThan(before));
  await act(() => page().settled());
  await settle();
  expect(shownNumber()).toBe(Number(label[1]));
  expect(screen.getByLabelText(`Back to page ${was}`)).toBeTruthy();
}, 60000);

it('two pages side by side (a wide screen): the footer shows both numbers, and going to a page shows it', async () => {
  const wide = { width: 1024, height: 700, scale: 2, fontScale: 1 };
  Dimensions.set({ window: wide, screen: wide });
  await open();
  expect(footer()).toMatch(/^1–2 of /);
  await goToPage(41);
  expect(footer()).toMatch(/^(40–41|41–42) of /);
}, 60000);
