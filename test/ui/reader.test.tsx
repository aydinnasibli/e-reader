/// <reference types="jest" />
// The real reader screen, with a small converted book, driven like a finger
// would: tap to show the menu, open Display, drag the size slider, long-press
// a word and highlight it.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Dimensions } from 'react-native';
import type { Block, Manifest } from '@/engine/types';
import { getAnnotations } from '@/lib/annotations';
import { setSettings } from '@/lib/settings';
import ReaderScreen from '@/app/reader/[id]';

const P1 = 'Call me Ishmael. Some years ago, never mind how long precisely, having little or no money in my purse.';
const P2 = 'It is a way I have of driving off the spleen and regulating the circulation.';
const blocks: Block[] = [{ k: 'h', l: 1, r: ['Loomings'] }, { k: 'p', r: [P1] }, { k: 'p', r: [P2] }];
const manifest: Manifest = {
  v: 1,
  format: 'txt',
  title: 'Moby-Dick',
  author: 'Melville',
  totalBlocks: blocks.length,
  totalChars: P1.length + P2.length + 8,
  chunks: [[0, 0]],
  toc: [{ t: 'Loomings', l: 0, b: 0 }],
  images: {},
};

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'moby' }), router: { back: jest.fn() } }));
jest.mock('expo-keep-awake', () => ({ useKeepAwake: () => {} }));
jest.mock('expo-screen-orientation', () => ({ lockAsync: () => Promise.resolve(), OrientationLock: {} }));
jest.mock('@/lib/library', () => {
  const entry = { id: 'moby', title: 'Moby-Dick', author: 'Melville', status: 'ready', format: 'txt', position: { b: 0, o: 0 } };
  return {
    getBook: () => entry,
    loadManifest: () => require('./reader.test').manifestForMock,
    useBookStatus: () => 'ready',
    useLiveBook: () => undefined,
    updateBook: () => {},
    reprocessBook: () => {},
    sourceFile: () => ({}),
  };
});
export const manifestForMock = manifest;

const { width: W } = Dimensions.get('window');
type El = { props: { style?: unknown; pointerEvents?: string }; parent: El | null };
/** Text on screen, not in the hidden view used to measure paragraphs. */
const shown = (text: string) =>
  screen.queryAllByText(text).filter((el) => {
    for (let n: El | null = el as unknown as El; n; n = n.parent) {
      const op = [n.props.style].flat().find((st) => (st as { opacity?: number })?.opacity === 0);
      if (op && n.props.pointerEvents === 'none') return false;
    }
    return true;
  });
const sizeOf = (el: { props: { [k: string]: unknown } }) =>
  ([el.props.style].flat() as ({ fontSize?: number } | undefined)[]).find((st) => st?.fontSize)?.fontSize;

beforeAll(() => {
  require('@/lib/storage').testChunks.set('moby/0', JSON.stringify({ b: blocks }));
});
beforeEach(() => setSettings({ mode: 'page', fontSize: 19, indent: false, hyphenate: false, align: 'left', pageTurn: 'none' }));

/** Wait for the first page; text layout falls back to estimates after a few seconds here. */
async function openBook() {
  render(<ReaderScreen />);
  await waitFor(() => expect(shown(P1).length).toBeGreaterThan(0), { timeout: 9000 });
}

it('size slider: the page text follows the slider live, then the pages are laid out at the new size', async () => {
  await openBook();
  // Tap the middle of the page for the menu, then Display.
  fireEvent.press(shown(P1)[0], { nativeEvent: { pageX: W / 2, pageY: 300 } });
  fireEvent.press(screen.getByLabelText('Display'));
  const slider = screen.getByTestId('slider-Size');

  act(() => fireEvent(slider, 'valueChange', 28));
  expect(shown(P1).map(sizeOf)).toContain(28); // drawn live
  act(() => fireEvent(slider, 'valueChange', 33));
  expect(shown(P1).map(sizeOf)).toContain(33);

  act(() => fireEvent(slider, 'slidingComplete', 33));
  // New pages are laid out at 33; the preview goes away once they are on screen.
  await waitFor(() => expect(shown(P1).map(sizeOf)).toEqual([33]), { timeout: 9000 });
}, 30000);

it('long-pressing a word selects that word, and highlighting marks just it', async () => {
  await openBook();
  // Give the page items their on-screen boxes (the test renderer has no layout).
  for (const view of screen.UNSAFE_root.findAll((n) => typeof n.props.onLayout === 'function' && n.props.children?.props?.block)) {
    fireEvent(view, 'layout', { nativeEvent: { layout: { x: 0, y: view.props.children.props.block.k === 'h' ? 0 : 60, width: W, height: 60 } } });
  }
  // Long-press near the start of the first line of P1 (the page starts below the header).
  const p1 = shown(P1)[0];
  fireEvent(p1, 'longPress', { nativeEvent: { pageX: 20 + 8, pageY: 70 } });
  await waitFor(() => expect(screen.getByText(/Tap words to extend/)).toBeTruthy());
  fireEvent.press(screen.getByLabelText('Highlight green'));
  const hs = getAnnotations('moby').highlights;
  expect(hs).toHaveLength(1);
  expect(hs[0]).toMatchObject({ b: 1, text: 'Call', color: 'green' });
}, 30000);
