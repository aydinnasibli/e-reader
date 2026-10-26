/// <reference types="jest" />
// Changing the text size, even many times in a row (a slider drag is one
// change per step), keeps the reader on the page it was on: the page is laid
// out again at the place the reader arrived at, not at the start of the page
// shown after the last change (up to a page earlier, so every step would
// creep back). And going to a page by its number lands on that page.

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { Block, Manifest } from '@/engine/types';
import { setSettings } from '@/lib/settings';
import ReaderScreen from '@/app/reader/[id]';
import type { FakePage } from './fakePage';

const para = (i: number) => `Paragraph ${i}. ` + 'The sea was calm and the sky was wide, and the ship went on through the night. '.repeat(3);
const blocks: Block[] = Array.from({ length: 80 }, (_, i) => ({ k: 'p', r: [para(i)] }));
const manifest: Manifest = {
  v: 1,
  format: 'txt',
  title: 'The Sea',
  author: '',
  totalBlocks: blocks.length,
  totalChars: blocks.reduce((n, b) => n + (b.r![0] as string).length, 0),
  chunks: [[0, 0]],
  toc: [],
  images: {},
};
export const manifestForMock = manifest;

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'sea' }), router: { back: jest.fn() } }));
jest.mock('expo-screen-orientation', () => ({ lockAsync: () => Promise.resolve(), OrientationLock: {} }));
jest.mock('@/lib/library', () => {
  const entry = { id: 'sea', title: 'The Sea', author: '', status: 'ready', format: 'txt', position: { b: 41, o: 0 } };
  return {
    getBook: () => entry,
    loadManifest: () => require('./fontDrift.test').manifestForMock,
    useBookStatus: () => 'ready',
    useLiveBook: () => undefined,
    updateBook: jest.fn(),
    reprocessBook: () => {},
    setBookOpen: () => {},
    sourceFile: () => ({}),
  };
});

const page = () => (globalThis as { __page?: FakePage }).__page!;
const P41 = { b: 41, i: 0 };

beforeAll(() => require('@/lib/storage').testChunks.set('sea/0', JSON.stringify({ b: blocks })));

it('many size changes: each lays the page out at the place opened, not where the last page started', async () => {
  setSettings({ mode: 'page', fontSize: 19, indent: false, hyphenate: false, align: 'left', pageTurn: 'none', seenTapZones: true });
  await render(<ReaderScreen />);
  await waitFor(() => expect(page().shown()).toBeTruthy(), { timeout: 5000 });
  // The page shown starts before paragraph 41 (pages hold several paragraphs).
  expect(page().shown().first.b).toBeLessThan(41);
  for (const fontSize of [20, 21, 22, 23, 22, 21, 20]) {
    await act(async () => setSettings({ fontSize }));
    await waitFor(() => expect(page().last('setup')!.setup.css).toContain(`font-size:${fontSize}px`));
    // On a page of its own (top): the line read stays at the top.
    expect(page().last('setup')!.target).toEqual({ at: P41, top: true });
  }
}, 30000);

it('after a page turn, the place kept is the page turned to', async () => {
  setSettings({ mode: 'page', fontSize: 19 });
  await render(<ReaderScreen />);
  await waitFor(() => expect(page().shown()).toBeTruthy(), { timeout: 5000 });
  await act(() => page().turn(1));
  const turnedTo = page().shown().first;
  await act(async () => setSettings({ fontSize: 24 }));
  await waitFor(() => expect(page().last('setup')!.setup.css).toContain('font-size:24px'));
  expect(page().last('setup')!.target).toEqual({ at: turnedTo, top: true });
}, 30000);

it('go to page: lands on the page with that number', async () => {
  setSettings({ mode: 'page', fontSize: 19 });
  const screen = await render(<ReaderScreen />);
  await waitFor(() => expect(page().shown()).toBeTruthy(), { timeout: 5000 });
  // The menu, then its page button.
  await act(() => page().emit({ t: 'tap' }));
  await fireEvent.press(screen.getByLabelText('Go to page'));
  await fireEvent.changeText(screen.getByLabelText('Page number'), '17');
  await fireEvent.press(screen.getByLabelText('Go'));
  await waitFor(() => expect(page().last('content')!.target).toEqual({ chunk: 0, page: 16 }));
  expect(await screen.findByText(/^17 of \d+ · /)).toBeTruthy();
  // Turning on from there: the place kept is the page landed on.
  await act(() => page().turn(1));
  expect(await screen.findByText(/^18 of \d+ · /)).toBeTruthy();
}, 30000);
