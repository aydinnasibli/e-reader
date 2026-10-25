/// <reference types="jest" />
// Changing the text size, even many times in a row (a slider drag is one
// change per step), keeps the reader on the page it was on: going back to the
// first size lands on the very same page, not a few pages earlier.

import { act, render, screen } from '@testing-library/react-native';
import type { Block, Manifest } from '@/engine/types';
import { setSettings } from '@/lib/settings';
import ReaderScreen from '@/app/reader/[id]';

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
    sourceFile: () => ({}),
  };
});

/** Let pending layout finish: the test renderer never reports text layout, so the reader falls back to estimates after a few seconds. */
async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => void jest.advanceTimersByTime(4100));
}
const pageLabel = () => (screen.getByText(/^\d+ of \d+ · /).props.children as string).split(' · ')[0];

beforeAll(() => require('@/lib/storage').testChunks.set('sea/0', JSON.stringify({ b: blocks })));

it('many size changes and back: each size always shows the same page, and the first size the page it started on', async () => {
  jest.useFakeTimers();
  setSettings({ mode: 'page', fontSize: 19, indent: false, hyphenate: false, align: 'left', pageTurn: 'none', seenTapZones: true });
  await render(<ReaderScreen />);
  await settle();
  const pageAt = new Map<number, string>([[19, pageLabel()]]);

  for (const fontSize of [20, 21, 22, 23, 22, 21, 20, 21, 22, 21, 20, 19]) {
    await act(async () => setSettings({ fontSize }));
    await settle();
    // Each size lands where it did the first time: the place doesn't creep back.
    const page = pageLabel();
    expect([fontSize, page]).toEqual([fontSize, pageAt.get(fontSize) ?? page]);
    pageAt.set(fontSize, page);
  }
  jest.useRealTimers();
}, 60000);
