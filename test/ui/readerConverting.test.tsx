/// <reference types="jest" />
// A book still being converted, on the reader screen: going to a page that
// isn't converted yet says so and stays put (not somewhere else, silently),
// and a picture that wasn't there yet is drawn once the book is complete.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Image } from 'react-native';
import type { Block, Manifest } from '@/engine/types';
import { setSettings } from '@/lib/settings';
import ReaderScreen from '@/app/reader/[id]';
import type { FakePage } from './fakePage';

const CHUNKS = 10;
const PER_CHUNK = 10;
const BLOCK = 400;
const blocks: Block[] = Array.from({ length: CHUNKS * PER_CHUNK }, (_, n) => (n === 1 ? { k: 'img', s: 'pic.png' } : { k: 'p', r: [`Block ${n}. `.padEnd(BLOCK, 'x')] }));
const chunkInfo = (c: number) => [c * PER_CHUNK, Math.max(0, c * PER_CHUNK * BLOCK - (c > 0 ? BLOCK - 1 : 0))] as [number, number];
// Five of ten chunks converted.
const live = {
  chunks: Array.from({ length: 5 }, (_, c) => chunkInfo(c)),
  totalBlocks: 5 * PER_CHUNK,
  totalChars: 5 * PER_CHUNK * BLOCK - BLOCK + 1,
  progress: 0.5,
};
const manifest: Manifest = {
  v: 2,
  format: 'fb2',
  title: 'Conv',
  author: '',
  totalBlocks: blocks.length,
  totalChars: blocks.length * BLOCK - BLOCK + 1,
  chunks: Array.from({ length: CHUNKS }, (_, c) => chunkInfo(c)),
  toc: [],
  images: { 'pic.png': { file: 'b_pic.png' } },
  lang: 'en',
};
/** The conversion as the library tells it: still going, then done. */
export const mockBook = {
  status: 'processing' as 'processing' | 'ready',
  live: live as typeof live | undefined,
  listeners: new Set<() => void>(),
  finish() {
    this.status = 'ready';
    this.live = undefined;
    this.listeners.forEach((l) => l());
  },
};
export const manifestForMock = manifest;

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'conv' }), router: { back: jest.fn() } }));
jest.mock('expo-screen-orientation', () => ({ lockAsync: () => Promise.resolve(), OrientationLock: {} }));
jest.mock('@/lib/library', () => {
  const book = () => require('./readerConverting.test').mockBook;
  const use = <T,>(get: () => T): T =>
    require('react').useSyncExternalStore((l: () => void) => {
      book().listeners.add(l);
      return () => book().listeners.delete(l);
    }, get);
  const entry = { id: 'conv', title: 'Conv', author: '', format: 'fb2', position: { b: 0, o: 0 }, lang: 'en' };
  return {
    getBook: () => ({ ...entry, status: book().status }),
    loadManifest: () => (book().status === 'ready' ? require('./readerConverting.test').manifestForMock : null),
    useBookStatus: () => use(() => book().status),
    useLiveBook: () => use(() => book().live),
    updateBook: () => {},
    reprocessBook: () => {},
    setBookOpen: () => {},
    sourceFile: () => ({}),
  };
});

const page = () => (globalThis as { __page?: FakePage }).__page!;
const footer = () => screen.getByText(/^\d+ of ~?\d+ · /).props.children as string;
const contents = () => page().sent.filter((m) => m.t === 'content');

beforeAll(() => {
  const st = require('@/lib/storage').testChunks as Map<string, string>;
  for (let c = 0; c < CHUNKS; c++) st.set(`conv/${c}`, JSON.stringify({ b: blocks.slice(c * PER_CHUNK, (c + 1) * PER_CHUNK) }));
  // The picture's size, once the picture is there.
  jest.spyOn(Image, 'getSize').mockImplementation((_uri, ok) => ok(120, 80));
});
beforeEach(() => setSettings({ mode: 'page', fontSize: 19, indent: false, hyphenate: false, align: 'left', pageTurn: 'none', seenTapZones: true }));

it("go to a page that isn't converted yet: it says so and the reader stays where it is", async () => {
  await render(<ReaderScreen />);
  await waitFor(() => expect(footer()).toMatch(/^1 of ~\d+/), { timeout: 5000 });
  await act(() => page().settled());
  const before = contents().length;
  await act(() => page().emit({ t: 'tap' }));
  await fireEvent.press(screen.getByLabelText('Go to page'));
  await fireEvent.changeText(screen.getByLabelText('Page number'), '80');
  await fireEvent.press(screen.getByLabelText('Go'));
  expect(screen.getByText('That part is still being prepared (50%).')).toBeTruthy();
  await act(async () => new Promise((r) => setTimeout(r, 100)));
  expect(contents()).toHaveLength(before);
  expect(footer()).toMatch(/^1 of ~/);
  // A page that is there: gone to.
  await fireEvent.changeText(screen.getByLabelText('Page number'), '20');
  await fireEvent.press(screen.getByLabelText('Go'));
  await waitFor(() => expect(contents().length).toBeGreaterThan(before));
  await act(() => page().settled());
  await waitFor(() => expect(footer()).toMatch(/^20 of ~/));
}, 30000);

it("a picture that wasn't there yet while converting is drawn once the book is complete", async () => {
  mockBook.status = 'processing';
  mockBook.live = live;
  await render(<ReaderScreen />);
  await waitFor(() => expect(page().shown()).toBeTruthy(), { timeout: 5000 });
  await act(() => page().settled());
  const html = () => contents().at(-1)!.chunks.find((c) => c.c === 0)!.html;
  expect(html()).toContain('<div data-b="1" class="img"></div>');
  await act(async () => mockBook.finish());
  await waitFor(() => expect(html()).toContain('width="120" height="80"'));
}, 30000);
