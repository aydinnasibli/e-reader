/// <reference types="jest" />
// The reader screen's smaller promises, with the page in the WebView played
// by the fake page: the highlighter put away marks nothing more; its drag is
// drawn on its own; the page is covered while it's laid out for a new size; a
// selection ticks once; a page loaded again that never answers is loaded
// another way; a page turn is one message; the auto page turn's bar fills once
// a page; and the menus' buttons are full-size targets, their text never cut.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Animated, Dimensions, Easing, StyleSheet } from 'react-native';
import type { Block, Manifest } from '@/engine/types';
import { getAnnotations } from '@/lib/annotations';
import { THEMES, setSettings } from '@/lib/settings';
import * as breathing from '@/reader/breather';
import { toolBar } from '@/reader/web/frame';
import type { FromPage } from '@/reader/web/protocol';
import ReaderScreen from '@/app/reader/[id]';
import type { FakePage } from './fakePage';

const para = (i: number) => `Paragraph ${i}. ` + 'The sea was calm and the sky was wide, and the ship went on through the night. '.repeat(4);
const blocks: Block[] = Array.from({ length: 40 }, (_, i) => ({ k: 'p', r: [para(i)] }));
const manifest: Manifest = {
  v: 1,
  format: 'txt',
  title: 'Sea',
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
// Short pages, so the auto page turn needn't wait a page's reading time.
jest.mock('@/reader/autoRead', () => ({ ...jest.requireActual('@/reader/autoRead'), pageDelay: () => 400 }));
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: () => Promise.resolve(),
  notificationAsync: () => Promise.resolve(),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success' },
}));
jest.mock('@/lib/library', () => {
  const entry = { id: 'sea', title: 'Sea', author: '', status: 'ready', format: 'txt', position: { b: 0, o: 0 } };
  return {
    getBook: () => entry,
    loadManifest: () => require('./readerDetails.test').manifestForMock,
    useBookStatus: () => 'ready',
    useLiveBook: () => undefined,
    updateBook: () => {},
    reprocessBook: () => {},
    setBookOpen: () => {},
    sourceFile: () => ({}),
  };
});

const g = globalThis as { __page?: FakePage; __webView?: Record<string, (e?: unknown) => void> & { source?: unknown }; __webViews?: number; __pageSilent?: boolean };
const page = () => g.__page!;
const emit = (m: FromPage) => act(() => page().emit(m));
const tapMiddle = () => emit({ t: 'tap' });
const window0 = Dimensions.get('window');
const flat = (el: { props: { style?: unknown } }) => (StyleSheet.flatten(el.props.style as never) ?? {}) as Record<string, number | undefined>;

beforeAll(() => require('@/lib/storage').testChunks.set('sea/0', JSON.stringify({ b: blocks })));
beforeEach(() => setSettings({ mode: 'page', fontSize: 19, indent: false, hyphenate: false, align: 'left', pageTurn: 'none', seenTapZones: true, theme: 'light' }));
afterEach(() => {
  jest.useRealTimers();
  g.__pageSilent = false;
  Dimensions.set({ window: window0, screen: window0 });
});

async function openBook() {
  await render(<ReaderScreen />);
  await waitFor(() => expect(page().shown()).toBeTruthy(), { timeout: 5000 });
  await act(() => page().settled());
}

it('Contents → Highlights with none yet says how to make one: with the Highlight tool', async () => {
  await openBook();
  await tapMiddle();
  await fireEvent.press(screen.getByLabelText('Contents'));
  await fireEvent.press(screen.getByText('Highlights'));
  expect(screen.getByText(/tap Highlight, then tap or drag over the text/)).toBeTruthy();
}, 30000);

it("the highlighter put away: a tap or a drag the page sends before it has heard marks nothing, and the drag shown is taken off", async () => {
  await openBook();
  await tapMiddle();
  await fireEvent.press(screen.getByLabelText('Highlight'));
  await emit({ t: 'markDrag', from: { b: 1, i: 1 }, to: { b: 2, i: 1 }, done: false });
  await act(() => page().settled());
  expect(page().stroke.length).toBeGreaterThan(0);
  // Done; the page is busy and hasn't heard yet: a touch meanwhile is still a marker's.
  const release = page().hold();
  await fireEvent.press(screen.getByLabelText('Done highlighting'));
  await emit({ t: 'markTap', at: { b: 3, i: 5 } });
  await emit({ t: 'markDrag', from: { b: 4, i: 1 }, to: { b: 5, i: 1 }, done: true });
  expect(getAnnotations('sea').highlights).toEqual([]);
  await act(async () => {
    release();
    await page().settled();
  });
  expect(page().marking).toBe(false);
  expect(page().stroke).toEqual([]);
}, 30000);

it('a highlighter drag is drawn as it goes on its own: the marks are not sent again with every move', async () => {
  await openBook();
  await tapMiddle();
  await fireEvent.press(screen.getByLabelText('Highlight'));
  await act(() => page().settled());
  const count = (t: string) => page().sent.filter((m) => m.t === t).length;
  const marks = count('marks');
  const strokes = count('stroke');
  for (let k = 1; k <= 5; k++) await emit({ t: 'markDrag', from: { b: 1, i: 1 }, to: { b: 1, i: 10 + k * 6 }, done: false });
  await act(() => page().settled());
  expect(count('marks')).toBe(marks);
  expect(count('stroke')).toBe(strokes + 5);
  expect(page().stroke).toEqual([expect.objectContaining({ b: 1, s: 0 })]);
}, 30000);

it('the phone turned: the page is covered until it is drawn in its new layout, and for 10 s at most', async () => {
  await openBook();
  expect(screen.queryByTestId('page-cover')).toBeNull();
  // The page busy laying out: the old layout isn't shown in the new size meanwhile.
  const release = page().hold();
  const landscape = { width: 800, height: 380, scale: 2, fontScale: 1 };
  await act(async () => Dimensions.set({ window: landscape, screen: landscape }));
  expect(screen.getByTestId('page-cover')).toBeTruthy();
  await act(async () => {
    release();
    await page().settled();
  });
  await waitFor(() => expect(screen.queryByTestId('page-cover')).toBeNull());
  // Turned back with the page never answering: covered while it lays out (seconds, on a slow phone), uncovered after 10 s whatever happens.
  const never = page().hold();
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  await act(async () => Dimensions.set({ window: window0, screen: window0 }));
  expect(screen.getByTestId('page-cover')).toBeTruthy();
  await act(async () => void jest.advanceTimersByTime(9000));
  expect(screen.getByTestId('page-cover')).toBeTruthy();
  await act(async () => void jest.advanceTimersByTime(1100));
  expect(screen.queryByTestId('page-cover')).toBeNull();
  never();
}, 30000);

it('a change of height only (the system bars, a window made taller): the page is not covered while it is laid out again', async () => {
  await openBook();
  const release = page().hold();
  const setups = page().sent.filter((m) => m.t === 'setup').length;
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  const shorter = { ...window0, height: window0.height - 40 };
  // Taken once it has held a moment: laid out again for it.
  await act(async () => Dimensions.set({ window: shorter, screen: shorter }));
  await act(async () => void jest.advanceTimersByTime(400));
  expect(page().sent.filter((m) => m.t === 'setup').length).toBe(setups + 1);
  // The old layout still fits, near enough, for the moment it takes: nothing covers the page.
  expect(screen.queryByTestId('page-cover')).toBeNull();
  release();
}, 30000);

it('what is wanted on screen is made at once: opening the book and turning the phone make nothing in pieces (a pause waits for the next frame)', async () => {
  const inPieces = jest.spyOn(breathing, 'breather');
  try {
    await openBook();
    const landscape = { width: 800, height: 380, scale: 2, fontScale: 1 };
    await act(async () => Dimensions.set({ window: landscape, screen: landscape }));
    await act(() => page().settled());
    await waitFor(() => expect(page().last('setup')!.setup.frame.width).toBe(800));
    expect(inPieces).not.toHaveBeenCalled();
  } finally {
    inPieces.mockRestore();
  }
}, 30000);

it('a selection ticks once when it is made or changed, not each time the page says where it is now', async () => {
  const tick = require('expo-haptics').selectionAsync as jest.Mock;
  await openBook();
  tick.mockClear();
  const select = (e: number, y: number) =>
    emit({ t: 'selection', start: { b: 1, i: 0 }, end: { b: 1, i: e }, startCaret: { x: 20, y, h: 28 }, endCaret: { x: 80, y, h: 28 } });
  await select(9, 70);
  // Scrolled: the same text, somewhere else on the screen.
  await select(9, 40);
  expect(tick).toHaveBeenCalledTimes(1);
  // A handle moved: more text.
  await select(15, 40);
  expect(tick).toHaveBeenCalledTimes(2);
}, 30000);

it("iPhone: the page loaded again after its process stopped, but never ready: loaded another way, as a new one would be", async () => {
  await openBook();
  const made = g.__webViews!;
  g.__pageSilent = true;
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  await act(async () => g.__webView!.onContentProcessDidTerminate());
  await act(async () => void jest.advanceTimersByTime(10_500));
  expect(g.__webViews).toBe(made + 1);
  expect(g.__webView!.source).toHaveProperty('html');
}, 30000);

it('a page turn is one message from the page: the place and its page number come together', async () => {
  await openBook();
  await waitFor(() => expect(screen.getByText(/^1 of \d+ · /)).toBeTruthy());
  await act(() => page().turn(1));
  expect(screen.getByText(/^2 of \d+ · /)).toBeTruthy();
}, 30000);

it('auto page turn: the bar fills once a page, not again when the turn is asked for', async () => {
  const timing = jest.spyOn(Animated, 'timing');
  await openBook();
  await waitFor(() => expect(screen.getByText(/^1 of \d+ · /)).toBeTruthy());
  await tapMiddle();
  timing.mockClear();
  await fireEvent.press(screen.getByLabelText('Auto page turn'));
  await waitFor(() => expect(screen.getByText(/^3 of \d+ · /)).toBeTruthy(), { timeout: 8000 });
  await act(async () => {});
  const fills = timing.mock.calls.filter(([, c]) => c.easing === Easing.linear).length;
  const at = Number(/^(\d+) of/.exec(String(screen.getByText(/^\d+ of \d+ · /).props.children))![1]);
  // Pages 1 to `at`, each filled once (the one just come may not have started yet).
  expect(fills).toBeLessThanOrEqual(at);
  expect(fills).toBeGreaterThanOrEqual(at - 1);
  timing.mockRestore();
}, 40000);

it('Display: a tab opens at its top; on a dark panel the dark colours have an edge you can see', async () => {
  setSettings({ theme: 'black' });
  await openBook();
  await tapMiddle();
  await fireEvent.press(screen.getByLabelText('Display'));
  const body = screen.getByTestId('display-body');
  await fireEvent.press(screen.getByText('Colours'));
  // A scroll view of its own: not the last tab's, scrolled down.
  expect(screen.getByTestId('display-body')).not.toBe(body);
  const black = screen.getAllByLabelText('#000000')[0];
  expect(flat(black).borderColor).not.toBe(THEMES.black.border);
  expect(flat(black).borderColor).toBe(THEMES.black.muted);
}, 30000);

it("the menu: the line with what's left is never cut short, and its buttons and the highlighter's colours are full-size targets", async () => {
  await openBook();
  await tapMiddle();
  expect(screen.getByText(/left in book/).props.numberOfLines).toBeGreaterThanOrEqual(2);
  // 44 points both ways of their own (a hit area past a button's row isn't touched on Android).
  for (const label of ['Previous chapter', 'Next chapter', 'Go to page']) {
    const button = screen.getByLabelText(label);
    const st = flat(button);
    expect(st.height ?? st.minHeight ?? 0).toBeGreaterThanOrEqual(44);
    expect(st.width ?? 44).toBeGreaterThanOrEqual(44);
    expect(button.props.hitSlop).toBeUndefined();
  }
  await fireEvent.press(screen.getByLabelText('Highlight'));
  // The highlighter's bar is over the header, above the text: its colours are
  // a finger wide, and touched as far up as the room there goes, 44 where
  // there's a status bar's room above (here none: up to the screen's edge).
  const dot = screen.getByLabelText('Highlight colour yellow');
  expect(flat(dot).width).toBeGreaterThanOrEqual(44);
  expect((flat(dot).height ?? 0) + (dot.props.hitSlop?.top ?? 0)).toBe(toolBar(0, 'page').reach);
}, 30000);
