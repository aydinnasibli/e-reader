/// <reference types="jest" />
// The real reader screen, with a small converted book, driven like the page
// in the WebView would: it reports taps, selections and highlighter strokes,
// and the screen answers with menus, highlights, jumps and page turns. (The
// page itself is tested in real browser engines: bench/webpage.)

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { BackHandler } from 'react-native';
import type { Block, Manifest } from '@/engine/types';
import { getAnnotations } from '@/lib/annotations';
import { setSettings } from '@/lib/settings';
import type { FromPage } from '@/reader/web/protocol';
import ReaderScreen from '@/app/reader/[id]';
import type { FakePage } from './fakePage';

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
const mockUpdateBook = jest.fn();
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'moby' }), router: { back: jest.fn() } }));
jest.mock('expo-screen-orientation', () => ({ lockAsync: () => Promise.resolve(), OrientationLock: {} }));
jest.mock('@/lib/library', () => {
  const entry = { id: 'moby', title: 'Moby-Dick', author: 'Melville', status: 'ready', format: 'txt', position: { b: 0, o: 0 } };
  return {
    getBook: () => entry,
    loadManifest: () => require('./reader.test').manifestForMock,
    useBookStatus: () => 'ready',
    useLiveBook: () => undefined,
    updateBook: (...a: unknown[]) => mockUpdateBook(...a),
    reprocessBook: () => {},
    setBookOpen: () => {},
    sourceFile: () => ({}),
  };
});
export const manifestForMock = manifest;

const page = () => (globalThis as { __page?: FakePage }).__page!;
/** The page says something. */
const emit = (m: FromPage) => act(() => page().emit(m));
const tapMiddle = () => emit({ t: 'tap' });
/** A selection on the page of P1's characters [s, e) (block 1; P1 is drawn without an indent here). */
const select = (s: number, e: number) =>
  emit({ t: 'selection', start: { b: 1, i: s }, end: { b: 1, i: e }, startCaret: { x: 20, y: 70, h: 28 }, endCaret: { x: 80, y: 70, h: 28 } });

beforeAll(async () => {
  require('@/lib/storage').testChunks.set('moby/0', JSON.stringify({ b: blocks }));
});
beforeEach(() => setSettings({ mode: 'page', fontSize: 19, indent: false, hyphenate: false, align: 'left', pageTurn: 'none', seenTapZones: true }));
// A test that fails with fake timers on must not leave them on: the next
// test's timeout would never fire and the whole run would hang (it did in CI).
afterEach(() => jest.useRealTimers());

/** Open the book: the page gets set up, then the chunk, and shows the first page. */
async function openBook() {
  await render(<ReaderScreen />);
  await waitFor(() => expect(page().last('content')).toBeTruthy(), { timeout: 5000 });
  await waitFor(() => expect(page().shown()).toBeTruthy());
}

it('the page gets the book: its look first, then the chunk around the place, with its text', async () => {
  await openBook();
  const setup = page().last('setup')!;
  expect(setup.setup.mode).toBe('page');
  expect(setup.setup.css).toContain('font-size:19px');
  expect(page().text(1)).toBe(P1);
  expect(page().last('content')!.target).toEqual({ at: { b: 0, i: 0 }, top: true });
}, 30000);

it('size slider: the text follows the slider live, then the page is laid out at the new size', async () => {
  await openBook();
  await tapMiddle();
  await fireEvent.press(screen.getByLabelText('Display'));
  const slider = screen.getByTestId('slider-Size');
  await act(() => fireEvent(slider, 'valueChange', 28));
  // Drawn live over the page while sliding.
  expect(screen.getAllByText(P1).length).toBeGreaterThan(0);
  await act(() => fireEvent(slider, 'slidingComplete', 28));
  // The page is set up again at 28, at the same place.
  await waitFor(() => expect(page().last('setup')!.setup.css).toContain('font-size:28px'));
  expect(page().last('setup')!.target).toEqual({ at: { b: 0, i: 0 }, top: true });
  // Once the page shows it, the preview goes.
  await waitFor(() => expect(screen.queryAllByText(P1)).toEqual([]), { timeout: 5000 });
}, 30000);

it('text selected on the page gets a menu to copy, look up, translate or share it', async () => {
  const copy = jest.spyOn(Clipboard, 'setStringAsync');
  await openBook();
  await select(0, 4);
  for (const label of ['Copy', 'Look Up', 'Translate', 'Share']) expect(screen.getByLabelText(label)).toBeTruthy();
  // No highlighting here: that's the highlight tool's.
  expect(screen.queryByLabelText(/Highlight colour/)).toBeNull();
  await fireEvent.press(screen.getByLabelText('Copy'));
  expect(copy).toHaveBeenCalledWith('Call');
  // The menu goes, and the page is told to end its selection.
  expect(screen.queryByLabelText('Copy')).toBeNull();
  expect(page().last('clearSelection')).toBeTruthy();
  expect(getAnnotations('moby').highlights.filter((h) => h.text === 'Call')).toEqual([]);
}, 30000);

it('a selection ended on the page closes the menu', async () => {
  await openBook();
  await select(0, 4);
  expect(screen.getByLabelText('Copy')).toBeTruthy();
  await emit({ t: 'noSelection' });
  expect(screen.queryByLabelText('Copy')).toBeNull();
}, 30000);

it('more than one word: no Look Up; exactly the characters selected are copied', async () => {
  const copy = jest.spyOn(Clipboard, 'setStringAsync');
  await openBook();
  // From inside "Call" to inside "Ishmael".
  await select(1, 10);
  expect(screen.queryByLabelText('Look Up')).toBeNull();
  await fireEvent.press(screen.getByLabelText('Copy'));
  expect(copy).toHaveBeenLastCalledWith('all me Is');
}, 30000);

describe('highlight tool', () => {
  // Highlights persist across tests in this file: compare against what was there before.
  const all = () => getAnnotations('moby').highlights.map((h) => [h.b, h.text, h.color]);
  let before: unknown[] = [];
  const highlights = () => all().filter((h) => !before.some((x) => JSON.stringify(x) === JSON.stringify(h)));
  beforeEach(() => (before = all()));
  const openTool = async () => {
    await openBook();
    await tapMiddle();
    await fireEvent.press(screen.getByLabelText('Highlight'));
    expect(page().last('tool')).toEqual({ t: 'tool', marking: true });
  };

  it('a drag highlights what it covers straight away, in the colour picked: no selection menu', async () => {
    await openTool();
    expect(screen.getByText(/Tap or drag over text to highlight it/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Highlight colour green'));
    // From the first word of P1 to the first word of P2, drawn as the finger moves.
    await emit({ t: 'markDrag', from: { b: 1, i: 1 }, to: { b: 2, i: 1 }, done: false });
    expect(page().marks.some((m) => m.b === 1 && m.s === 0)).toBe(true);
    expect(highlights()).toEqual([]);
    await emit({ t: 'markDrag', from: { b: 1, i: 1 }, to: { b: 2, i: 1 }, done: true });
    expect(highlights()).toEqual([
      [1, P1, 'green'],
      [2, 'It', 'green'],
    ]);
    expect(screen.queryByLabelText('Look Up')).toBeNull();
    // The panel acts on what was just highlighted.
    for (const label of ['Note', 'Copy', 'Remove']) expect(screen.getByLabelText(label)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Remove'));
    expect(highlights()).toEqual([]);
  }, 30000);

  it('a tap highlights the word; a tap on the highlight takes it away; Done puts the tool away', async () => {
    await openTool();
    await fireEvent.press(screen.getByLabelText('Highlight colour blue'));
    await emit({ t: 'markTap', at: { b: 2, i: 9 } });
    expect(highlights()).toEqual([[2, 'way', 'blue']]);
    // Drawn on the page.
    expect(page().marks.some((m) => m.b === 2 && m.s === 8 && m.e === 11)).toBe(true);
    await emit({ t: 'markTap', at: { b: 2, i: 9 } });
    expect(highlights()).toEqual([]);
    await fireEvent.press(screen.getByLabelText('Done highlighting'));
    expect(page().last('tool')).toEqual({ t: 'tool', marking: false });
  }, 30000);
});

describe('tap zones', () => {
  it('the first time, a guide shows the zones; a tap dismisses it for good', async () => {
    setSettings({ seenTapZones: false });
    await openBook();
    expect(screen.getByText('Menu')).toBeTruthy();
    expect(screen.getAllByText('Next page').length).toBe(1);
    await fireEvent.press(screen.getByLabelText('Got it'));
    expect(screen.queryByText('Menu')).toBeNull();
  }, 30000);

  it('a tap in the middle of the page opens the menu', async () => {
    await openBook();
    expect(screen.queryByLabelText('Display')).toBeNull();
    await tapMiddle();
    expect(screen.getByLabelText('Display')).toBeTruthy();
  }, 30000);
});

describe('page numbers, back after a jump, auto page turn', () => {
  it('the footer shows the page number; the top shows the battery with its symbol', async () => {
    await openBook();
    await waitFor(() => expect(screen.getByText(/^1 of 1 · /)).toBeTruthy(), { timeout: 3000 });
    expect(await screen.findByLabelText('Battery 82%')).toBeTruthy();
    const fills = screen.getByTestId('battery-glyph').queryAll((n) => [n.props.style].flat().some((st: { width?: unknown } | null) => st?.width === '82%'));
    expect(fills.length).toBeGreaterThan(0);
  }, 30000);

  it('after jumping from the contents, a chip goes back to where you were', async () => {
    await openBook();
    await tapMiddle();
    await fireEvent.press(screen.getByLabelText('Contents'));
    // "Loomings" is also the page header; the contents entry is drawn last.
    const entries = await screen.findAllByText('Loomings');
    await fireEvent.press(entries[entries.length - 1]);
    const chip = await screen.findByLabelText(/^Back to page \d+$/);
    await fireEvent.press(chip);
    await waitFor(() => expect(screen.queryByLabelText(/^Back to page/)).toBeNull());
  }, 30000);

  it('auto page turn: started from the menu, speed, pause and stop; it asks the page to turn', async () => {
    // Faking setImmediate stalls the test renderer on Node 22 (CI's Node).
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    await openBook();
    await tapMiddle();
    await fireEvent.press(screen.getByLabelText('Auto page turn'));
    const speed = () => Number(/(\d+) wpm/.exec(screen.getByText(/\d+ wpm/).props.children.join(''))?.[1]);
    const before = speed();
    await fireEvent.press(screen.getByLabelText('Faster'));
    expect(speed()).toBeGreaterThan(before);
    await act(async () => void jest.advanceTimersByTime(120_000));
    // Turning past this short book's only page: the book ends, and auto page turn with it.
    await waitFor(() => expect(screen.queryByText(/\d+ wpm/)).toBeNull());
    jest.useRealTimers();
  }, 30000);

  it('auto-scroll: the page is asked to scroll, and says when it reached the end', async () => {
    setSettings({ mode: 'scroll' });
    await openBook();
    await tapMiddle();
    await fireEvent.press(await screen.findByLabelText('Auto-scroll'));
    expect(screen.getByText(/\d+ wpm/)).toBeTruthy();
    await waitFor(() => expect(page().last('auto')!.speed).toBeGreaterThan(0));
    await emit({ t: 'autoEnd' });
    expect(screen.queryByText(/\d+ wpm/)).toBeNull();
    expect(page().last('auto')!.speed).toBe(0);
  }, 30000);
});

describe('Android back button', () => {
  let back: () => boolean | null | undefined = () => false;
  beforeEach(async () => {
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, handler) => {
      back = handler as unknown as () => boolean;
      return { remove: () => {} };
    });
  });
  afterEach(() => jest.restoreAllMocks());
  const press = async () => {
    let handled: boolean | null | undefined;
    await act(() => {
      handled = back();
    });
    return handled;
  };

  it('closes the Display panel, or the menu, before leaving the book', async () => {
    await openBook();
    await tapMiddle();
    await fireEvent.press(screen.getByLabelText('Display'));
    expect(await press()).toBe(true);
    expect(await press()).toBe(false);
    await tapMiddle();
    expect(screen.getByLabelText('Contents')).toBeTruthy();
    expect(await press()).toBe(true);
    expect(await press()).toBe(false);
  }, 30000);

  it('ends a selection first', async () => {
    await openBook();
    await select(0, 4);
    expect(screen.getByLabelText('Copy')).toBeTruthy();
    expect(await press()).toBe(true);
    expect(screen.queryByLabelText('Copy')).toBeNull();
    expect(page().last('clearSelection')).toBeTruthy();
    expect(await press()).toBe(false);
  }, 30000);

  it('turns the highlight tool off, and stops auto page turn', async () => {
    await openBook();
    await tapMiddle();
    await fireEvent.press(screen.getByLabelText('Highlight'));
    expect(page().last('tool')!.marking).toBe(true);
    expect(await press()).toBe(true);
    expect(page().last('tool')!.marking).toBe(false);
    await tapMiddle();
    await fireEvent.press(screen.getByLabelText('Auto page turn'));
    expect(screen.getByText(/\d+ wpm/)).toBeTruthy();
    expect(await press()).toBe(true);
    expect(screen.queryByText(/\d+ wpm/)).toBeNull();
  }, 30000);
});

describe('the end of the book', () => {
  it('turning past the last page marks the book finished and says so', async () => {
    mockUpdateBook.mockClear();
    await openBook();
    // Opening on the last page isn't finishing it.
    expect(mockUpdateBook.mock.calls.some(([, patch]) => patch.finished)).toBe(false);
    await emit({ t: 'end' });
    expect(await screen.findByLabelText('Finished · Back to library')).toBeTruthy();
    expect(mockUpdateBook).toHaveBeenCalledWith('moby', { finished: true });
  }, 30000);
});

describe('getting around from the menu', () => {
  it('Go to page: a page number, or a percentage; out of range says what to type', async () => {
    await openBook();
    await tapMiddle();
    await waitFor(() => expect(screen.getByText(/^1 of 1 · /)).toBeTruthy(), { timeout: 3000 });
    await fireEvent.press(screen.getByLabelText('Go to page'));
    expect(screen.getByText(/You're on page 1 of 1/)).toBeTruthy();
    const field = screen.getByLabelText('Page number');
    await fireEvent.changeText(field, '7');
    await fireEvent.press(screen.getByLabelText('Go'));
    expect(screen.getByText('Enter a page from 1 to 1.')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('By percentage'));
    await fireEvent.changeText(screen.getByLabelText('Percentage'), '50');
    expect(screen.queryByText(/Enter a/)).toBeNull();
    await fireEvent.press(screen.getByLabelText('Go'));
    expect(await screen.findByLabelText(/^Back to page \d+$/)).toBeTruthy();
  }, 30000);

  it('chapter buttons: none before the first chapter or after the last', async () => {
    await openBook();
    await tapMiddle();
    expect(screen.getByLabelText('Previous chapter').props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByLabelText('Next chapter').props.accessibilityState?.disabled).toBe(true);
  }, 30000);

  it('a footnote link on the page opens the note', async () => {
    await openBook();
    await emit({ t: 'link', target: 'missing-note' });
    // A note that isn't in the book: the sheet says so rather than nothing happening.
    expect(await screen.findByText("This note couldn't be found in the book.")).toBeTruthy();
  }, 30000);
});
