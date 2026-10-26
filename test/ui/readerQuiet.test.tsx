/// <reference types="jest" />
// Nothing redraws while nothing moves: with text selected and its menu shown,
// the screen does no work (battery); and the page telling the same selection
// again (as it may, while its handles are shown) changes nothing.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { Profiler } from 'react';
import type { Block, Manifest } from '@/engine/types';
import { setSettings } from '@/lib/settings';
import ReaderScreen from '@/app/reader/[id]';
import type { FakePage } from './fakePage';

const blocks: Block[] = Array.from({ length: 12 }, (_, i) => ({ k: 'p', r: [`${i + 1}. The sea was calm and the sky was wide, and the ship went on through the night. `.repeat(3)] }));
const manifest: Manifest = {
  v: 2,
  format: 'txt',
  title: 'Quiet',
  author: '',
  totalBlocks: blocks.length,
  totalChars: blocks.reduce((n, b) => n + (b.r![0] as string).length, 0),
  chunks: [[0, 0]],
  toc: [],
  images: {},
  lang: 'en',
};
export const manifestForMock = manifest;

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'quiet' }), router: { back: jest.fn() } }));
jest.mock('expo-screen-orientation', () => ({ lockAsync: () => Promise.resolve(), OrientationLock: {} }));
jest.mock('@/lib/library', () => ({
  getBook: () => ({ id: 'quiet', title: 'Quiet', author: '', status: 'ready', format: 'txt', position: { b: 0, o: 0 } }),
  loadManifest: () => require('./readerQuiet.test').manifestForMock,
  useBookStatus: () => 'ready',
  useLiveBook: () => undefined,
  updateBook: () => {},
  reprocessBook: () => {},
  setBookOpen: () => {},
  sourceFile: () => ({}),
}));

const page = () => (globalThis as { __page?: FakePage }).__page!;
const wait = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));
beforeAll(() => require('@/lib/storage').testChunks.set('quiet/0', JSON.stringify({ b: blocks })));

it('text selected, nothing moving: no redraws; the same selection told again changes nothing', async () => {
  setSettings({ mode: 'page', fontSize: 19, indent: false, hyphenate: false, align: 'left', pageTurn: 'none', seenTapZones: true });
  let commits = 0;
  await render(
    <Profiler id="reader" onRender={() => void commits++}>
      <ReaderScreen />
    </Profiler>,
  );
  await waitFor(() => expect(page().shown()).toBeTruthy(), { timeout: 5000 });
  await act(() => page().settled());
  await wait(500);
  const tick = jest.spyOn(Haptics, 'selectionAsync');
  // A word selected; its menu laid out (it measures itself once).
  const selection = { t: 'selection' as const, start: { b: 1, i: 3 }, end: { b: 1, i: 6 }, startCaret: { x: 120.25, y: 300.5, h: 28 }, endCaret: { x: 160.75, y: 300.5, h: 28 } };
  await act(() => page().emit(selection));
  // The menu measures itself (its width, to sit centred over the selection).
  const menu = screen.getByLabelText('Copy').parent!.parent!;
  await act(() => fireEvent(menu, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 260, height: 38 } } }));
  await wait(100);
  await wait(100);
  commits = 0;
  // Two seconds with nothing happening: nothing drawn again (a loop would draw every frame).
  await wait(2000);
  expect(commits).toBe(0);
  // The page tells the same selection again and again (its handles shown): nothing to redraw, no tick.
  for (let k = 0; k < 10; k++) await act(() => page().emit({ ...selection, startCaret: { ...selection.startCaret, x: 120.25 + (k % 2) * 0.1 } }));
  await wait(100);
  expect(commits).toBeLessThanOrEqual(1);
  expect(tick).toHaveBeenCalledTimes(1);
}, 30000);
