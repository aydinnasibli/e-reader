/// <reference types="jest" />
// Auto page turn on a book of several pages: the pages really turn.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { Block, Manifest } from '@/engine/types';
import { setSettings } from '@/lib/settings';
import ReaderScreen from '@/app/reader/[id]';
import type { FakePage } from './fakePage';

const para = (i: number) => `Paragraph ${i}. ` + 'The sea was calm and the sky was wide, and the ship went on through the night. '.repeat(4);
const blocks: Block[] = Array.from({ length: 40 }, (_, i) => ({ k: 'p', r: [para(i)] }));
const total = blocks.reduce((n, b) => n + (b.r![0] as string).length, 0);
const manifest: Manifest = { v: 1, format: 'txt', title: 'Sea', author: '', totalBlocks: blocks.length, totalChars: total, chunks: [[0, 0]], toc: [], images: {} };

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'sea' }), router: { back: jest.fn() } }));
// Short pages, so the test needn't wait a page's reading time.
jest.mock('@/reader/autoRead', () => ({ ...jest.requireActual('@/reader/autoRead'), pageDelay: () => 600 }));
jest.mock('expo-screen-orientation', () => ({ lockAsync: () => Promise.resolve(), OrientationLock: {} }));
jest.mock('@/lib/library', () => {
  const entry = { id: 'sea', title: 'Sea', author: '', status: 'ready', format: 'txt', position: { b: 0, o: 0 } };
  return {
    getBook: () => entry,
    loadManifest: () => require('./autoread.test').manifestForMock,
    useBookStatus: () => 'ready',
    useLiveBook: () => undefined,
    updateBook: () => {},
    reprocessBook: () => {},
    setBookOpen: () => {},
    sourceFile: () => ({}),
  };
});
export const manifestForMock = manifest;

const page = () => (globalThis as { __page?: FakePage }).__page!;

beforeAll(async () => {
  require('@/lib/storage').testChunks.set('sea/0', JSON.stringify({ b: blocks }));
});

it('auto page turn turns the pages', async () => {
  setSettings({ mode: 'page', seenTapZones: true, pageTurn: 'none', hyphenate: false, autoWpm: 1000 });
  await render(<ReaderScreen />);
  await waitFor(() => expect(screen.getByText(/^1 of \d+ · /)).toBeTruthy(), { timeout: 9000 });
  await act(() => page().emit({ t: 'tap' }));
  await fireEvent.press(screen.getByLabelText('Auto page turn'));
  // While a page waits, a line fills up in the auto bar: it's visibly working.
  expect(screen.getByTestId('auto-page-timer')).toBeTruthy();
  await waitFor(() => expect(screen.getByText(/^2 of \d+ · /)).toBeTruthy(), { timeout: 8000 });
  await waitFor(() => expect(screen.getByText(/^3 of \d+ · /)).toBeTruthy(), { timeout: 8000 });
}, 40000);
