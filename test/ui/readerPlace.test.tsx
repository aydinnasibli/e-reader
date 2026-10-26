/// <reference types="jest" />
// Where the reader is, as the screen keeps it: a jump moves the place read
// only once the reader reads on from where it lands; the place is saved now
// and then while it keeps moving (auto-scroll); the "Back to page" chip goes
// after ten page turns, not after the page is laid out again; and jumping to
// the notes at the end doesn't finish the book.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { Block, Manifest } from '@/engine/types';
import { setSettings } from '@/lib/settings';
import ReaderScreen from '@/app/reader/[id]';
import { BookData } from '@/reader/book';
import type { FakePage } from './fakePage';

const CHUNKS = 16;
const PER_CHUNK = 4;
const para = (n: number) => `Paragraph ${n}. The sea was calm and the sky was wide.`.padEnd(400, ' On.').slice(0, 400);
const blocks: Block[] = Array.from({ length: CHUNKS * PER_CHUNK }, (_, n) => ({ k: 'p', r: [para(n)] }));
const manifest: Manifest = {
  v: 2,
  format: 'txt',
  title: 'Sea',
  author: '',
  totalBlocks: blocks.length,
  totalChars: blocks.length * 400,
  chunks: Array.from({ length: CHUNKS }, (_, c) => [c * PER_CHUNK, c * PER_CHUNK * 400] as [number, number]),
  // The story, then its notes (the last chunk).
  toc: [...Array.from({ length: CHUNKS - 1 }, (_, c) => ({ t: `Chapter ${c + 1}`, l: 0, b: c * PER_CHUNK })), { t: 'Notes', l: 0, b: (CHUNKS - 1) * PER_CHUNK }],
  images: {},
  notes: { n1: [(CHUNKS - 1) * PER_CHUNK + 1, (CHUNKS - 1) * PER_CHUNK + 2] },
};
export const manifestForMock = manifest;
export const paramsForMock: { id: string; b?: string; o?: string } = { id: 'sea' };
/** The book as the library has it: where reading left off, and its percent. */
export const entryForMock: { id: string; title: string; author: string; status: string; format: string; position: { b: number; o: number }; percent?: number } = {
  id: 'sea',
  title: 'Sea',
  author: '',
  status: 'ready',
  format: 'txt',
  position: { b: 0, o: 0 },
};
const mockUpdateBook = jest.fn();

jest.mock('expo-router', () => ({ useLocalSearchParams: () => require('./readerPlace.test').paramsForMock, router: { back: jest.fn() } }));
jest.mock('expo-screen-orientation', () => ({ lockAsync: () => Promise.resolve(), OrientationLock: {} }));
jest.mock('@/lib/library', () => {
  return {
    getBook: () => require('./readerPlace.test').entryForMock,
    loadManifest: () => require('./readerPlace.test').manifestForMock,
    useBookStatus: () => 'ready',
    useLiveBook: () => undefined,
    updateBook: (...a: unknown[]) => mockUpdateBook(...a),
    reprocessBook: () => {},
    setBookOpen: () => {},
    sourceFile: () => ({}),
  };
});

const page = () => (globalThis as { __page?: FakePage }).__page!;
const emit = (m: Parameters<FakePage['emit']>[0]) => act(() => page().emit(m));
const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));
const saved = () => mockUpdateBook.mock.calls.filter(([, p]) => p.position).map(([, p]) => p.position);
const contents = () => page().sent.filter((m) => m.t === 'content').length;

beforeAll(() => {
  const st = require('@/lib/storage').testChunks as Map<string, string>;
  for (let c = 0; c < CHUNKS; c++) st.set(`sea/${c}`, JSON.stringify({ b: blocks.slice(c * PER_CHUNK, (c + 1) * PER_CHUNK) }));
});
beforeEach(() => {
  setSettings({ mode: 'page', fontSize: 19, indent: false, hyphenate: false, align: 'left', pageTurn: 'none', seenTapZones: true });
  mockUpdateBook.mockClear();
  delete paramsForMock.b;
  delete paramsForMock.o;
  entryForMock.position = { b: 0, o: 0 };
  delete entryForMock.percent;
});
afterEach(() => jest.useRealTimers());

async function open() {
  const view = await render(<ReaderScreen />);
  await waitFor(() => expect(page().shown()).toBeTruthy(), { timeout: 5000 });
  await act(() => page().settled());
  return view;
}

/** Menu → Contents → a chapter, and wait for the page to show it. */
async function toChapter(n: number) {
  const before = contents();
  await emit({ t: 'tap' });
  await fireEvent.press(screen.getByLabelText('Contents'));
  await fireEvent.press(screen.getByText(`Chapter ${n}`));
  await waitFor(() => expect(contents()).toBeGreaterThan(before));
  await act(() => page().settled());
}

describe('the place read after a jump', () => {
  it('jumped and left without reading on: the place read stays where it was', async () => {
    const view = await open();
    await act(async () => {
      page().turn(1);
      await page().settled();
    });
    const reading = { b: 1, o: 0 };
    await toChapter(9);
    expect(page().shown().first.b).toBe(32);
    await settle(1000);
    await view.unmount();
    expect(saved().at(-1)).toEqual(reading);
    expect(saved().some((p) => p.b >= 32)).toBe(false);
  }, 30000);

  it('jumped, then a page turned: the place read is the new one', async () => {
    const view = await open();
    await toChapter(9);
    await act(async () => {
      page().turn(1);
      await page().settled();
    });
    await settle(1000);
    expect(saved().at(-1)).toEqual({ b: 33, o: 0 });
    await view.unmount();
    expect(saved().at(-1)).toEqual({ b: 33, o: 0 });
  }, 30000);

  it('two jumps without reading on, then the Back chip (to the place between), then closed: the place read is still where reading was', async () => {
    const view = await open();
    await act(async () => {
      page().turn(1);
      await page().settled();
    });
    const reading = { b: 1, o: 0 };
    await toChapter(5); // block 16
    await toChapter(9); // block 32
    const before = contents();
    await fireEvent.press(await screen.findByLabelText(/^Back to page \d+$/));
    await waitFor(() => expect(contents()).toBeGreaterThan(before));
    await act(() => page().settled());
    expect(page().shown().first.b).toBe(16);
    await settle(1000);
    await view.unmount();
    expect(saved().at(-1)).toEqual(reading);
  }, 30000);

  it('opened at a highlight and closed: the place read and its percent are kept as they were', async () => {
    // Reading left off in chunk 1, in its third paragraph: a chunk not read this time.
    entryForMock.position = { b: 6, o: 200 };
    entryForMock.percent = (6 * 400 + 200) / (CHUNKS * PER_CHUNK * 400);
    paramsForMock.b = '40';
    paramsForMock.o = '0';
    const view = await open();
    expect(page().shown().first.b).toBe(40);
    await settle(1000);
    await view.unmount();
    const saves = mockUpdateBook.mock.calls.map(([, p]) => p).filter((p) => p.position);
    expect(saves.length).toBeGreaterThan(0);
    for (const p of saves) {
      expect(p.position).toEqual({ b: 6, o: 200 });
      expect(p.percent).toBeCloseTo(entryForMock.percent, 3);
    }
  }, 30000);

  it('opened at a highlight: "Back to page N" names the page it goes back to', async () => {
    entryForMock.position = { b: 6, o: 200 };
    paramsForMock.b = '40';
    paramsForMock.o = '0';
    await open();
    await settle(50);
    const chip = await screen.findByLabelText(/^Back to page \d+$/);
    const said = Number(/(\d+)$/.exec(chip.props.accessibilityLabel)![1]);
    const before = contents();
    await fireEvent.press(chip);
    await waitFor(() => expect(contents()).toBeGreaterThan(before));
    await act(() => page().settled());
    await settle(50);
    expect(page().shown().first.b).toBe(6);
    expect(Number(/^(\d+)/.exec(screen.getByText(/^\d+(–\d+)? of ~?\d+ · /).props.children as string)![1])).toBe(said);
  }, 30000);

  it('opened at a highlight (from Highlights & notes) and closed: the place read stays where reading left off', async () => {
    paramsForMock.b = '40';
    paramsForMock.o = '0';
    const view = await open();
    expect(page().shown().first.b).toBe(40);
    await settle(1000);
    await view.unmount();
    expect(saved().every((p) => p.b === 0)).toBe(true);
  }, 30000);
});

it('auto-scroll: the place is saved along the way, not only when the book is closed', async () => {
  setSettings({ mode: 'scroll' });
  await open();
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  mockUpdateBook.mockClear();
  // A paragraph every half second, as the page reports while it scrolls.
  for (let k = 1; k <= 60; k++) {
    await act(async () => {
      page().emit({ t: 'shown', first: { b: k, i: 0 }, next: null, chunk: Math.floor(k / PER_CHUNK), turned: true, key: page().key, lastPage: false });
      jest.advanceTimersByTime(500);
    });
  }
  // Thirty seconds of reading: saved every few seconds.
  expect(saved().length).toBeGreaterThanOrEqual(5);
  expect(saved().at(-1)!.b).toBeGreaterThan(50);
}, 60000);

it('the Back chip goes after ten page turns, not when the page is laid out again', async () => {
  await open();
  await toChapter(5);
  expect(await screen.findByLabelText(/^Back to page \d+$/)).toBeTruthy();
  // The page laid out again (a picture loaded, a chunk added): no page turned.
  for (let k = 0; k < 12; k++) await emit({ t: 'shown', first: page().shown().first, next: null, chunk: page().shown().c, turned: false, key: page().key, lastPage: false });
  expect(screen.getByLabelText(/^Back to page \d+$/)).toBeTruthy();
  for (let k = 0; k < 11; k++) {
    await act(async () => {
      page().turn(1);
      await page().settled();
    });
    await settle();
  }
  expect(screen.queryByLabelText(/^Back to page \d+$/)).toBeNull();
}, 30000);

it("following a note into the notes at the end doesn't finish the book, though the page told of the old page meanwhile", async () => {
  await open();
  // The notes take a moment to read.
  const read = BookData.prototype.loadChunk;
  const slow = jest.spyOn(BookData.prototype, 'loadChunk').mockImplementation(function (this: BookData, i: number) {
    const p = read.call(this, i);
    return i === CHUNKS - 1 ? p.then((b) => new Promise((r) => setTimeout(() => r(b), 200))) : p;
  });
  await emit({ t: 'link', target: 'n1' });
  await fireEvent.press(await screen.findByText('Go to note'));
  // The page, not given the jump yet, reports the page it had (a chunk was added).
  await emit({ t: 'shown', first: page().shown().first, next: null, chunk: page().shown().c, turned: false, key: page().key, lastPage: false });
  await waitFor(() => expect(page().shown().c).toBe(CHUNKS - 1));
  slow.mockRestore();
  await act(() => page().settled());
  // Reading on in the notes, to the end and past it.
  for (let k = 0; k < 4; k++) {
    await act(async () => {
      page().turn(1);
      await page().settled();
    });
  }
  expect(mockUpdateBook.mock.calls.some(([, p]) => p.finished)).toBe(false);
  expect(screen.queryByLabelText('Finished · Back to library')).toBeNull();
}, 30000);
