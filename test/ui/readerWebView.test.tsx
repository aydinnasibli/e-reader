/// <reference types="jest" />
// The page's WebView on the reader screen: brought back after the system
// stops its process (a new WebView on Android, where a dead one can't be
// used again), loaded another way when it doesn't load, and an error with
// "Try again" when nothing helps; given the book's language; and laid out
// once as the reader opens, not again when the system bars come and go.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Dimensions } from 'react-native';
import type { Block, Manifest } from '@/engine/types';
import { recordCrash } from '@/lib/crashLog';
import { setSettings } from '@/lib/settings';
import ReaderScreen from '@/app/reader/[id]';
import type { FakePage } from './fakePage';

const tr = 'Bu kitap, uzun bir yolculuğun ve o yolculukta karşılaşılan insanların hikâyesidir. Her şey bir sabah başladı. ';
const blocks: Block[] = Array.from({ length: 12 }, (_, i) => ({ k: 'p', r: [`${i + 1}. ${tr.repeat(3)}`] }));
const manifest: Manifest = {
  v: 1,
  format: 'txt',
  title: 'Yolculuk',
  author: '',
  totalBlocks: blocks.length,
  totalChars: blocks.reduce((n, b) => n + (b.r![0] as string).length, 0),
  chunks: [[0, 0]],
  toc: [],
  images: {},
};
export const manifestForMock = manifest;
export const entryForMock: { id: string; title: string; author: string; status: string; format: string; position: { b: number; o: number }; lang?: string } = {
  id: 'trip',
  title: 'Yolculuk',
  author: '',
  status: 'ready',
  format: 'txt',
  position: { b: 0, o: 0 },
};
const mockOpen = jest.fn();
/** What the screen asked of the library, in order. */
export const mockCalls: string[] = [];

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'trip' }), router: { back: jest.fn() } }));
jest.mock('expo-screen-orientation', () => ({ lockAsync: () => Promise.resolve(), OrientationLock: {} }));
jest.mock('@/lib/crashLog', () => ({ recordCrash: jest.fn(), useRecordScreenError: () => {} }));
jest.mock('@/lib/library', () => ({
  getBook: () => require('./readerWebView.test').entryForMock,
  loadManifest: () => {
    require('./readerWebView.test').mockCalls.push('manifest');
    return require('./readerWebView.test').manifestForMock;
  },
  useBookStatus: () => 'ready',
  useLiveBook: () => undefined,
  updateBook: () => {},
  reprocessBook: () => {},
  setBookOpen: (...a: unknown[]) => {
    require('./readerWebView.test').mockCalls.push(`open ${a[1]}`);
    mockOpen(...a);
  },
  sourceFile: () => ({}),
}));
// Insets that change as the system bars hide and show.
const mockInsets = { now: { top: 24, bottom: 48, left: 0, right: 0 }, listeners: new Set<() => void>() };
export function setInsets(i: Partial<typeof mockInsets.now>) {
  mockInsets.now = { ...mockInsets.now, ...i };
  mockInsets.listeners.forEach((l) => l());
}
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context/jest/mock').default;
  return {
    ...actual,
    useSafeAreaInsets: () =>
      require('react').useSyncExternalStore(
        (l: () => void) => {
          mockInsets.listeners.add(l);
          return () => mockInsets.listeners.delete(l);
        },
        () => mockInsets.now,
      ),
  };
});

const g = globalThis as { __page?: FakePage; __webView?: Record<string, (e?: unknown) => void>; __webViews?: number; __pageSilent?: boolean };
const page = () => g.__page!;
const window0 = Dimensions.get('window');
const setups = () => page().sent.filter((m) => m.t === 'setup');

beforeAll(() => require('@/lib/storage').testChunks.set('trip/0', JSON.stringify({ b: blocks })));
beforeEach(() => {
  setSettings({ mode: 'page', fontSize: 19, indent: false, hyphenate: false, align: 'left', pageTurn: 'none', seenTapZones: true });
  (recordCrash as jest.Mock).mockClear();
  mockInsets.now = { top: 24, bottom: 48, left: 0, right: 0 };
  delete entryForMock.lang;
  g.__pageSilent = false;
});
afterEach(() => jest.useRealTimers());

async function open() {
  const view = await render(<ReaderScreen />);
  await waitFor(() => expect(page().shown()).toBeTruthy(), { timeout: 5000 });
  await act(() => page().settled());
  return view;
}

describe("the page's process", () => {
  it("Android stops it: a new WebView is made, set up and given the book; stopped again at once: an error with Try again", async () => {
    await open();
    const made = g.__webViews!;
    await act(async () => g.__webView!.onRenderProcessGone({ nativeEvent: { didCrash: false } }));
    await waitFor(() => expect(g.__webViews).toBe(made + 1));
    await waitFor(() => expect(page().shown()).toBeTruthy());
    await act(() => page().settled());
    expect(page().last('setup')).toBeTruthy();
    expect(page().text(1)).toBe(blocks[1].r![0]);
    expect(recordCrash).toHaveBeenCalledTimes(1);
    // Again within seconds: something is wrong; say so instead of a blank page.
    await act(async () => g.__webView!.onRenderProcessGone({ nativeEvent: { didCrash: true } }));
    expect(await screen.findByText('The page stopped working twice in a row.')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Try again'));
    await waitFor(() => expect(g.__webViews).toBe(made + 2));
    await waitFor(() => expect(page().shown()).toBeTruthy());
    expect(screen.queryByText('The page stopped working twice in a row.')).toBeNull();
  }, 30000);

  it("iPhone stops it: the same WebView loads it again, and it's given the book again", async () => {
    await open();
    const made = g.__webViews!;
    const contents = () => page().sent.filter((m) => m.t === 'content').length;
    const before = contents();
    await act(async () => g.__webView!.onContentProcessDidTerminate());
    await waitFor(() => expect(contents()).toBeGreaterThan(before));
    await act(() => page().settled());
    expect(page().shown()).toBeTruthy();
    expect(g.__webViews).toBe(made);
    expect(page().text(1)).toBe(blocks[1].r![0]);
  }, 30000);

  it("a page that never says it's ready: loaded as HTML instead, then an error with Try again", async () => {
    g.__pageSilent = true;
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    await render(<ReaderScreen />);
    const made = g.__webViews!;
    await act(async () => void jest.advanceTimersByTime(10_500));
    // Loaded again, in a new WebView, with the page's HTML given directly.
    expect(g.__webViews).toBe(made + 1);
    expect(g.__webView!.source).toHaveProperty('html');
    await act(async () => void jest.advanceTimersByTime(10_500));
    expect(screen.getByText("The page didn't load.")).toBeTruthy();
    expect(recordCrash).toHaveBeenCalled();
    g.__pageSilent = false;
    await fireEvent.press(screen.getByLabelText('Try again'));
    await act(async () => void jest.advanceTimersByTime(500));
    jest.useRealTimers();
    await waitFor(() => expect(page().shown()).toBeTruthy(), { timeout: 5000 });
  }, 30000);
});

describe("the book's language", () => {
  it('a book that names none (an old TXT) is told from its text: the page gets it', async () => {
    await open();
    expect(page().last('setup')!.setup.lang).toBe('tr');
  }, 30000);

  it("the language set in the book's details wins", async () => {
    entryForMock.lang = 'az';
    await open();
    expect(page().last('setup')!.setup.lang).toBe('az');
  }, 30000);

  it('the library is told the book is open (before its manifest is read), and when it closes', async () => {
    mockOpen.mockClear();
    mockCalls.length = 0;
    const view = await open();
    expect(mockOpen).toHaveBeenLastCalledWith('trip', true);
    // Open first: a book converted again isn't swapped in between the two.
    expect(mockCalls.slice(0, 2)).toEqual(['open true', 'manifest']);
    await view.unmount();
    expect(mockOpen).toHaveBeenLastCalledWith('trip', false);
    expect(mockOpen.mock.calls.filter(([, o]) => o).length).toBe(mockOpen.mock.calls.filter(([, o]) => !o).length);
  }, 30000);
});

// (On fake timers: "not laid out again" is checked once the time it would take has surely passed.)
const later = (ms: number) => act(async () => void jest.advanceTimersByTime(ms));

describe('the reading area', () => {
  it('the bars hiding as the book opens: laid out once, for the bars hidden', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    await render(<ReaderScreen />);
    // The status and navigation bars go away a moment after the reader opens.
    await later(50);
    await act(async () => setInsets({ top: 0, bottom: 0 }));
    await waitFor(() => expect(page().shown()).toBeTruthy(), { timeout: 5000 });
    await later(600);
    await act(() => page().settled());
    expect(setups()).toHaveLength(1);
    expect(setups()[0].setup.frame.height).toBe(require('react-native').Dimensions.get('window').height - 30 - 30);
  }, 30000);

  it('the menu brings the bars back: the book is not laid out again', async () => {
    mockInsets.now = { top: 0, bottom: 0, left: 0, right: 0 };
    await open();
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const before = setups().length;
    await act(() => page().emit({ t: 'tap' }));
    await act(async () => setInsets({ top: 24, bottom: 48 }));
    await later(600);
    await act(() => page().emit({ t: 'tap' }));
    await act(async () => setInsets({ top: 0, bottom: 0 }));
    await later(600);
    await act(() => page().settled());
    expect(setups()).toHaveLength(before);
  }, 30000);
});

it('the bars going away in steps as the menu closes (the status bar, then the navigation bar): the book is not laid out for the step between', async () => {
  mockInsets.now = { top: 0, bottom: 0, left: 0, right: 0 };
  await open();
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  const before = setups().length;
  await act(() => page().emit({ t: 'tap' }));
  await act(async () => setInsets({ top: 24, bottom: 48 }));
  await later(600);
  // Closed: the status bar goes at once, the navigation bar half a second later.
  await act(() => page().emit({ t: 'tap' }));
  await act(async () => setInsets({ top: 0 }));
  await later(500);
  await act(async () => setInsets({ bottom: 0 }));
  await later(1500);
  await act(() => page().settled());
  expect(setups()).toHaveLength(before);
}, 30000);

it('a phone on its side with the navigation bar at the side: the menu bringing it back does not lay the book out again', async () => {
  const landscape = { width: 800, height: 380, scale: 2, fontScale: 1 };
  Dimensions.set({ window: landscape, screen: landscape });
  mockInsets.now = { top: 0, bottom: 0, left: 0, right: 0 };
  await open();
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  await later(400);
  await act(() => page().settled());
  const before = setups().length;
  // The menu: the navigation bar comes back, at the right-hand side; then it goes again.
  await act(() => page().emit({ t: 'tap' }));
  await act(async () => setInsets({ right: 48 }));
  await later(400);
  await act(() => page().emit({ t: 'tap' }));
  await act(async () => setInsets({ right: 0 }));
  await later(400);
  await act(() => page().settled());
  expect(setups()).toHaveLength(before);
  Dimensions.set({ window: window0, screen: window0 });
}, 30000);

it('auto-scrolling when the page is loaded again: the new page is told to scroll on, after it is set up', async () => {
  setSettings({ mode: 'scroll', autoWpm: 250 });
  await open();
  await act(() => page().emit({ t: 'tap' }));
  await fireEvent.press(screen.getByLabelText('Auto-scroll'));
  await act(async () => new Promise((r) => setTimeout(r, 30)));
  expect(page().last('auto')!.speed).toBeGreaterThan(0);
  // The system stops the page's process; the same WebView loads it again.
  const mark = page().sent.length;
  await act(async () => g.__webView!.onContentProcessDidTerminate());
  await waitFor(() => expect(page().sent.slice(mark).some((m) => m.t === 'content')).toBe(true));
  await act(() => page().settled());
  const after = page().sent.slice(mark).map((m) => (m.t === 'auto' ? `auto:${m.speed > 0 ? 'on' : 'off'}` : m.t));
  // The page has a view only once it's set up: 'auto' must come after 'setup' to do anything.
  expect(after.slice(after.indexOf('setup'))).toContain('auto:on');
  setSettings({ mode: 'page' });
}, 30000);
