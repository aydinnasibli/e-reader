/// <reference types="jest" />
// Reopening a book that is being converted again (the app was killed while
// converting, or "Prepare it again"): the saved place far into the book
// doesn't exist yet. The reader must wait for it, not jump to what exists
// and overwrite the saved place.

import { act, render, screen, waitFor } from '@testing-library/react-native';
import type { Block } from '@/engine/types';
import { setSettings } from '@/lib/settings';
import ReaderScreen from '@/app/reader/[id]';

const blocks: Block[] = [{ k: 'p', r: ['First paragraph of the book.'] }, { k: 'p', r: ['Second paragraph.'] }];
const mockUpdateBook = jest.fn();

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'big' }), router: { back: jest.fn() } }));
jest.mock('expo-screen-orientation', () => ({ lockAsync: () => Promise.resolve(), OrientationLock: {} }));
// Like the real store: the same object until something changes.
const mockLive = { chunks: [[0, 0]], totalBlocks: 2, totalChars: 45, progress: 0.01 };
jest.mock('@/lib/library', () => ({
  // Saved place: block 5000. Only the first chunk (2 blocks) is converted so far.
  getBook: () => ({ id: 'big', title: 'Big', author: '', status: 'processing', position: { b: 5000, o: 12 }, percent: 0.4 }),
  loadManifest: () => null,
  useBookStatus: () => 'processing',
  useLiveBook: () => mockLive,
  updateBook: (...a: unknown[]) => mockUpdateBook(...a),
  reprocessBook: () => {},
  sourceFile: () => ({}),
}));

beforeAll(() => {
  require('@/lib/storage').testChunks.set('big/0', JSON.stringify({ b: blocks }));
});
beforeEach(() => setSettings({ mode: 'page', indent: false, hyphenate: false }));

it('waits for the saved place instead of overwriting it', async () => {
  const { unmount } = render(<ReaderScreen />);
  await waitFor(() => expect(screen.getByText(/Preparing the book up to where you left off/)).toBeTruthy());
  // Give the reader time to lay out what exists (the measurer falls back after 4 s here).
  await act(() => new Promise((r) => setTimeout(r, 5000)));
  expect(screen.getByText(/Preparing the book up to where you left off/)).toBeTruthy();
  unmount();
  // Leaving saves, but never a position or percent that isn't the saved place.
  for (const [, patch] of mockUpdateBook.mock.calls) {
    expect(patch.position).toBeUndefined();
    expect(patch.percent).toBeUndefined();
  }
}, 20000);

it('scroll mode waits too', async () => {
  setSettings({ mode: 'scroll' });
  mockUpdateBook.mockClear();
  const { unmount } = render(<ReaderScreen />);
  await waitFor(() => expect(screen.getByText(/Preparing the book up to where you left off/)).toBeTruthy());
  unmount();
  for (const [, patch] of mockUpdateBook.mock.calls) expect(patch.position).toBeUndefined();
});
