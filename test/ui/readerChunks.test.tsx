/// <reference types="jest" />
// The chunks the reader screen gives the page, and what it draws over them:
// highlights and the search hit are the ones of now (not of when the reader
// opened), a chunk visited again still has its text on the screen's side,
// turning on through the book shows every block in order, and switching
// between pages and scrolling or changing colours doesn't make a new page or
// move the text.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import type { Block, Manifest } from '@/engine/types';
import { addHighlight } from '@/lib/annotations';
import { setSettings } from '@/lib/settings';
import ReaderScreen from '@/app/reader/[id]';
import { BookData } from '@/reader/book';
import type { FakePage } from './fakePage';

const CHUNKS = 20;
const PER_CHUNK = 4;
// A page a paragraph (the fake page holds 400 characters a page).
const para = (n: number) =>
  (n === 17 ? 'Far away an albatross circled the mast, and the sea was calm.' : `Chapter ${Math.floor(n / PER_CHUNK) + 1} paragraph ${n}. The sea was calm and the sky was wide tonight.`)
    .padEnd(400, ' And on.')
    .slice(0, 400);
const blocks: Block[] = Array.from({ length: CHUNKS * PER_CHUNK }, (_, n) => ({ k: 'p', r: [para(n)] }));
const len = (b: Block) => (b.r![0] as string).length;
const firstChar = (c: number) => blocks.slice(0, c * PER_CHUNK).reduce((n, b) => n + len(b), 0);
const manifest: Manifest = {
  v: 2,
  format: 'txt',
  title: 'Twenty',
  author: '',
  totalBlocks: blocks.length,
  totalChars: blocks.reduce((n, b) => n + len(b), 0),
  chunks: Array.from({ length: CHUNKS }, (_, c) => [c * PER_CHUNK, firstChar(c)] as [number, number]),
  toc: Array.from({ length: CHUNKS }, (_, c) => ({ t: `Chapter ${c + 1}`, l: 0, b: c * PER_CHUNK })),
  images: {},
};
export const manifestForMock = manifest;

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'twenty' }), router: { back: jest.fn() } }));
jest.mock('expo-screen-orientation', () => ({ lockAsync: () => Promise.resolve(), OrientationLock: {} }));
jest.mock('@/lib/library', () => {
  const entry = { id: 'twenty', title: 'Twenty', author: '', status: 'ready', format: 'txt', position: { b: 0, o: 0 } };
  return {
    getBook: () => entry,
    loadManifest: () => require('./readerChunks.test').manifestForMock,
    useBookStatus: () => 'ready',
    useLiveBook: () => undefined,
    updateBook: () => {},
    reprocessBook: () => {},
    setBookOpen: () => {},
    sourceFile: () => ({}),
  };
});

const page = () => (globalThis as { __page?: FakePage }).__page!;
const webViews = () => (globalThis as { __webViews?: number }).__webViews ?? 0;
const emit = (m: Parameters<FakePage['emit']>[0]) => act(() => page().emit(m));
const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));
const sentOf = (t: string) => page().sent.filter((m) => m.t === t).length;

beforeAll(() => {
  const st = require('@/lib/storage').testChunks as Map<string, string>;
  for (let c = 0; c < CHUNKS; c++) st.set(`twenty/${c}`, JSON.stringify({ b: blocks.slice(c * PER_CHUNK, (c + 1) * PER_CHUNK) }));
});
beforeEach(() => setSettings({ mode: 'page', fontSize: 19, indent: false, hyphenate: false, align: 'left', pageTurn: 'none', seenTapZones: true, theme: 'light' }));

async function open() {
  await render(<ReaderScreen />);
  await waitFor(() => expect(page().shown()).toBeTruthy(), { timeout: 5000 });
  await act(() => page().settled());
}

/** Menu → Go to page → by percentage, and wait for the page to show it. */
async function percent(p: number) {
  const before = sentOf('content');
  await emit({ t: 'tap' });
  await fireEvent.press(screen.getByLabelText('Go to page'));
  await fireEvent.press(screen.getByLabelText('By percentage'));
  await fireEvent.changeText(screen.getByLabelText('Percentage'), String(p));
  await fireEvent.press(screen.getByLabelText('Go'));
  await waitFor(() => expect(sentOf('content')).toBeGreaterThan(before));
  await act(() => page().settled());
  await settle();
}

describe('highlights and the search hit drawn on the page are the ones of now', () => {
  it('a search result tapped in another chapter is marked there', async () => {
    await open();
    await emit({ t: 'tap' });
    await fireEvent.press(screen.getByLabelText('Search'));
    const box = screen.getByPlaceholderText('Search in book');
    await fireEvent.changeText(box, 'albatross');
    await fireEvent(box, 'submitEditing');
    await fireEvent.press(await screen.findByText('albatross'));
    await waitFor(() => expect(page().shown().c).toBe(4));
    await act(() => page().settled());
    const o = para(17).indexOf('albatross');
    expect(page().marks.some((m) => m.b === 17 && m.s === o && m.e === o + 9)).toBe(true);
  }, 30000);

  it('a highlight made now stays drawn after reading on into the next chapter, and after a jump away and back', async () => {
    await open();
    await emit({ t: 'tap' });
    await fireEvent.press(screen.getByLabelText('Highlight'));
    const o = para(1).indexOf('calm');
    await emit({ t: 'markTap', at: { b: 1, i: o + 1 } });
    await fireEvent.press(screen.getByLabelText('Done highlighting'));
    expect(page().marks.some((m) => m.b === 1 && m.s === o)).toBe(true);
    // Into chunk 1: the screen adds chunk 2.
    await act(async () => {
      for (let k = 0; k < 4; k++) page().turn(1);
      await page().settled();
    });
    await waitFor(() => expect(page().sent.some((m) => m.t === 'add' && m.chunks.some((c) => c.c === 2))).toBe(true));
    await act(() => page().settled());
    expect(page().marks.some((m) => m.b === 1 && m.s === o)).toBe(true);
    // Away to the middle of the book and back with the chip.
    await percent(60);
    await fireEvent.press(await screen.findByLabelText(/^Back to page \d+$/));
    await waitFor(() => expect(page().shown().c).toBeLessThanOrEqual(1));
    await act(() => page().settled());
    expect(page().marks.some((m) => m.b === 1 && m.s === o)).toBe(true);
  }, 30000);
});

it('back in a chunk seen before, after visiting many others: its highlight is drawn and a selection there copies its text', async () => {
  const o = para(5).indexOf('sea');
  addHighlight('twenty', { b: 5, s: o, e: o + 3, color: 'yellow', text: 'sea' });
  await open();
  await percent(6);
  await waitFor(() => expect(page().marks.some((m) => m.b === 5)).toBe(true));
  // Far apart: each visit loads three chunks, more than the book keeps in memory.
  for (const p of [22, 42, 62, 82, 97]) await percent(p);
  // Back to it from the highlights list (nothing read from the book on the way).
  const before = sentOf('content');
  await emit({ t: 'tap' });
  await fireEvent.press(screen.getByLabelText('Contents'));
  await fireEvent.press(screen.getByText(/^Highlights/));
  await fireEvent.press(screen.getByText('sea'));
  await waitFor(() => expect(sentOf('content')).toBeGreaterThan(before));
  await act(() => page().settled());
  expect(page().shown().c).toBe(1);
  expect(page().marks.some((m) => m.b === 5 && m.s === o)).toBe(true);
  const copy = jest.spyOn(Clipboard, 'setStringAsync');
  await emit({ t: 'selection', start: { b: 5, i: o }, end: { b: 5, i: o + 3 }, startCaret: { x: 20, y: 70, h: 28 }, endCaret: { x: 80, y: 70, h: 28 } });
  await fireEvent.press(screen.getByLabelText('Copy'));
  expect(copy).toHaveBeenLastCalledWith('sea');
}, 60000);

it('turning page by page through the book shows every page in order', async () => {
  await open();
  const seen = [`${page().shown().first.b}:${page().shown().first.i}`];
  const at = () => `${page().shown().first.b}:${page().shown().first.i}`;
  for (let k = 0; k < 40; k++) {
    const from = at();
    for (let tries = 0; tries < 5 && at() === from; tries++) {
      await act(async () => {
        page().turn(1);
        await page().settled();
      });
      await settle();
    }
    seen.push(at());
  }
  // Each block once a page here (short paragraphs), in order, none skipped.
  expect(seen.map((s) => Number(s.split(':')[0]))).toEqual(Array.from({ length: 41 }, (_, n) => n));
}, 60000);

it('switching between pages and scrolling keeps the same page, set up and given its chunks, highlights and all', async () => {
  const o = para(2).indexOf('wide');
  addHighlight('twenty', { b: 2, s: o, e: o + 4, color: 'green', text: 'wide' });
  await open();
  const made = webViews();
  await act(async () => setSettings({ mode: 'scroll' }));
  await act(() => page().settled());
  await settle();
  expect(webViews()).toBe(made);
  expect(page().mode).toBe('scroll');
  expect(page().text(2)).toBe(para(2));
  expect(page().marks.some((m) => m.b === 2 && m.s === o)).toBe(true);
  await act(async () => setSettings({ mode: 'page' }));
  await act(() => page().settled());
  await settle();
  expect(webViews()).toBe(made);
  expect(page().mode).toBe('page');
  expect(page().marks.some((m) => m.b === 2 && m.s === o)).toBe(true);
}, 30000);

it('a colour change restyles the page without laying it out again at another place', async () => {
  await open();
  await act(async () => {
    page().turn(1);
    await page().settled();
  });
  const shownBefore = page().shown().first;
  const contents = sentOf('content');
  const setups = sentOf('setup');
  const key = page().key;
  await act(async () => setSettings({ theme: 'sepia' }));
  await act(() => page().settled());
  await settle();
  expect(sentOf('setup')).toBe(setups + 1);
  expect(sentOf('content')).toBe(contents);
  const setup = page().last('setup')!;
  // The same layout (the page needn't measure anything again), and the page shown: not a page started
  // at the place read (which would move the text).
  expect(setup.key).toBe(key);
  expect(setup.target).toEqual({ at: shownBefore });
  expect(page().shown().first).toEqual(shownBefore);
}, 30000);

it('a jump made while an earlier one is still being prepared wins: the earlier one never lands', async () => {
  await open();
  // The chunk with the albatross is slow to read.
  const read = BookData.prototype.loadChunk;
  const slow = jest.spyOn(BookData.prototype, 'loadChunk').mockImplementation(function (this: BookData, i: number) {
    const p = read.call(this, i);
    return i === 4 ? p.then((b) => new Promise((r) => setTimeout(() => r(b), 300))) : p;
  });
  await emit({ t: 'tap' });
  await fireEvent.press(screen.getByLabelText('Search'));
  const box = screen.getByPlaceholderText('Search in book');
  await fireEvent.changeText(box, 'albatross');
  await fireEvent(box, 'submitEditing');
  await fireEvent.press(await screen.findByText('albatross'));
  // At once, before it's there: the next chapter.
  await emit({ t: 'tap' });
  await fireEvent.press(screen.getByLabelText('Next chapter'));
  await settle();
  await act(async () => new Promise((r) => setTimeout(r, 500)));
  await act(() => page().settled());
  expect(page().shown().c).toBe(1);
  expect(page().sent.filter((m) => m.t === 'content').every((m) => !m.chunks.some((c) => c.c === 4))).toBe(true);
  slow.mockRestore();
}, 30000);
