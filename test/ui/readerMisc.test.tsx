/// <reference types="jest" />
// Smaller things on the reader screen: a note's popup without its link back,
// that link (and others to places in the book) going there, a bookmark's
// label starting at a word, the menu's chapter and pages left following the
// slider as it's dragged, and the highlight tool's bar clear of the page number.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { Block, Manifest } from '@/engine/types';
import { getAnnotations } from '@/lib/annotations';
import { setSettings } from '@/lib/settings';
import ReaderScreen from '@/app/reader/[id]';
import type { FakePage } from './fakePage';

const CHUNKS = 6;
const PER_CHUNK = 4;
const para = (n: number) => `Paragraph ${n}. The sea was calm and the sky was wide.`.padEnd(400, ' On.').slice(0, 400);
const blocks: Block[] = Array.from({ length: CHUNKS * PER_CHUNK }, (_, n): Block => {
  // A long paragraph (two pages) with the note's reference near its end.
  if (n === 2) return { k: 'p', r: ['The whale'.padEnd(500, ' and on'), ['1', 8 | 32, 'n1'], ' rose.'.padEnd(200, ' on')] };
  // The note, with its number linking back to the reference, and a "Back" link.
  if (n === 21) return { k: 'p', r: [['1', 32, 'ref1'], '. A sperm whale, as the crew would learn. ', ['Back', 32, 'ref1']] };
  return { k: 'p', r: [para(n)] };
});
const len = (b: Block) => b.r!.map((r) => (typeof r === 'string' ? r : r[0])).join('').length;
const firstChar = (c: number) => blocks.slice(0, c * PER_CHUNK).reduce((n, b) => n + len(b), 0);
const manifest: Manifest = {
  v: 2,
  format: 'epub',
  title: 'Notes',
  author: '',
  totalBlocks: blocks.length,
  totalChars: blocks.reduce((n, b) => n + len(b), 0),
  chunks: Array.from({ length: CHUNKS }, (_, c) => [c * PER_CHUNK, firstChar(c)] as [number, number]),
  toc: Array.from({ length: CHUNKS }, (_, c) => ({ t: `Chapter ${c + 1}`, l: 0, b: c * PER_CHUNK })),
  images: {},
  notes: { n1: [21, 22] },
  anchors: { ref1: 2 },
  // Where in its paragraph the reference is (the converter's anchorOffsets).
  ...({ anchorOffsets: { ref1: 500 } } as object),
};
export const manifestForMock = manifest;
export const entryForMock = { id: 'notes', title: 'Notes', author: '', status: 'ready', format: 'epub', position: { b: 0, o: 0 } };

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'notes' }), router: { back: jest.fn() } }));
jest.mock('expo-screen-orientation', () => ({ lockAsync: () => Promise.resolve(), OrientationLock: {} }));
jest.mock('@/lib/library', () => ({
  getBook: () => require('./readerMisc.test').entryForMock,
  loadManifest: () => require('./readerMisc.test').manifestForMock,
  useBookStatus: () => 'ready',
  useLiveBook: () => undefined,
  updateBook: () => {},
  reprocessBook: () => {},
  setBookOpen: () => {},
  sourceFile: () => ({}),
}));

const page = () => (globalThis as { __page?: FakePage }).__page!;
const emit = (m: Parameters<FakePage['emit']>[0]) => act(() => page().emit(m));
const contents = () => page().sent.filter((m) => m.t === 'content').length;

beforeAll(() => {
  const st = require('@/lib/storage').testChunks as Map<string, string>;
  for (let c = 0; c < CHUNKS; c++) st.set(`notes/${c}`, JSON.stringify({ b: blocks.slice(c * PER_CHUNK, (c + 1) * PER_CHUNK) }));
});
beforeEach(() => {
  setSettings({ mode: 'page', fontSize: 19, indent: false, hyphenate: false, align: 'left', pageTurn: 'none', seenTapZones: true });
  entryForMock.position = { b: 0, o: 0 };
});

async function open() {
  await render(<ReaderScreen />);
  await waitFor(() => expect(page().shown()).toBeTruthy(), { timeout: 5000 });
  await act(() => page().settled());
}

it("a note's popup leaves out its links back to the reference", async () => {
  await open();
  await emit({ t: 'link', target: 'n1' });
  expect(await screen.findByText('A sperm whale, as the crew would learn.', { exact: false })).toBeTruthy();
  expect(screen.queryByText(/Back/)).toBeNull();
  expect(screen.queryByText(/^1\./)).toBeNull();
}, 30000);

it("a link to a place in the book that isn't a note (a note's link back) goes there", async () => {
  entryForMock.position = { b: 21, o: 0 };
  await open();
  expect(page().shown().first.b).toBe(21);
  const before = contents();
  await emit({ t: 'link', target: 'ref1' });
  await waitFor(() => expect(contents()).toBeGreaterThan(before));
  await act(() => page().settled());
  // The page with the reference on it: the paragraph's second page, not its first.
  expect(page().shown().first).toEqual({ b: 2, i: 400 });
  expect(screen.queryByText("This note couldn't be found in the book.")).toBeNull();
  // And back to the note with the chip.
  expect(await screen.findByLabelText(/^Back to page \d+$/)).toBeTruthy();
}, 30000);

it("a bookmark's label starts at the start of a word (as the library makes it for a moved one)", async () => {
  await open();
  // The page starts inside a word (broken at a hyphen): "agraph 3. The sea…".
  await emit({ t: 'shown', first: { b: 3, i: 3 }, next: { b: 4, i: 0 }, chunk: 0, turned: true, key: page().key, lastPage: false });
  await emit({ t: 'tap' });
  await fireEvent.press(screen.getByLabelText('Bookmark'));
  expect(getAnnotations('notes').bookmarks.at(-1)!.snippet).toMatch(/^Paragraph 3\. The sea/);
}, 30000);

it('dragging the slider: the chapter and pages left are those of where it would go', async () => {
  await open();
  await emit({ t: 'tap' });
  expect(screen.getAllByText('Chapter 1').length).toBeGreaterThan(0);
  await act(() => fireEvent(screen.getByTestId('progress-slider'), 'valueChange', 0.75));
  expect(screen.getAllByText('Chapter 5').length).toBeGreaterThan(0);
}, 30000);

it("the highlight tool's bar sits above the page number", async () => {
  await open();
  await emit({ t: 'tap' });
  await fireEvent.press(screen.getByLabelText('Highlight'));
  const bar = screen.getByLabelText('Done highlighting').parent!.parent!;
  const style = Object.assign({}, ...[bar.props.style].flat(3));
  // The safe area (none here), the footer (30) and a gap.
  expect(style.bottom).toBeGreaterThanOrEqual(30);
}, 30000);

it('scroll mode: the text scrolling under a selection takes its menu away, until the page says where the selection is', async () => {
  setSettings({ mode: 'scroll' });
  await open();
  const select = () => emit({ t: 'selection', start: { b: 1, i: 0 }, end: { b: 1, i: 9 }, startCaret: { x: 20, y: 300, h: 28 }, endCaret: { x: 120, y: 300, h: 28 } });
  await select();
  expect(screen.getByLabelText('Copy')).toBeTruthy();
  await emit({ t: 'shown', first: { b: 1, i: 0 }, next: null, chunk: 0, turned: true, key: page().key, lastPage: false });
  expect(screen.queryByLabelText('Copy')).toBeNull();
  await select();
  expect(screen.getByLabelText('Copy')).toBeTruthy();
}, 30000);
