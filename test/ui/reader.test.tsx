/// <reference types="jest" />
// The real reader screen, with a small converted book, driven like a finger
// would: tap to show the menu, open Display, drag the size slider, long-press
// a word and highlight it.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, BackHandler, Dimensions } from 'react-native';
import type { Block, Manifest } from '@/engine/types';
import { getAnnotations } from '@/lib/annotations';
import { setSettings } from '@/lib/settings';
import ReaderScreen from '@/app/reader/[id]';
import { DialogHost } from '@/ui/dialogs';

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
    sourceFile: () => ({}),
  };
});
export const manifestForMock = manifest;

const { width: W } = Dimensions.get('window');
type El = { props?: { style?: unknown; pointerEvents?: string }; parent: El | null };
/** Text on screen, not in the hidden view used to measure paragraphs. */
const shown = (text: string) =>
  screen.queryAllByText(text).filter((el) => {
    for (let n: El | null = el as unknown as El; n; n = n.parent) {
      const op = [n.props?.style].flat().find((st) => (st as { opacity?: number })?.opacity === 0);
      if (op && n.props?.pointerEvents === 'none') return false;
    }
    return true;
  });
const sizeOf = (el: { props: { [k: string]: unknown } }) =>
  ([el.props.style].flat() as ({ fontSize?: number } | undefined)[]).find((st) => st?.fontSize)?.fontSize;

beforeAll(() => {
  require('@/lib/storage').testChunks.set('moby/0', JSON.stringify({ b: blocks }));
});
beforeEach(() => setSettings({ mode: 'page', fontSize: 19, indent: false, hyphenate: false, align: 'left', pageTurn: 'none', seenTapZones: true }));

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

describe('highlight tool', () => {
  /** Page items get their on-screen boxes: heading 0–60, P1 60–120, P2 120–180. */
  const layOut = () => {
    for (const view of screen.UNSAFE_root.findAll((n) => typeof n.props.onLayout === 'function' && n.props.children?.props?.block)) {
      const block = view.props.children.props.block as Block;
      const y = block.k === 'h' ? 0 : block.r?.[0] === P1 ? 60 : 120;
      fireEvent(view, 'layout', { nativeEvent: { layout: { x: 0, y, width: W, height: 60 } } });
    }
  };
  const ev = (pageX: number, pageY: number) => ({ nativeEvent: { pageX, pageY } });
  // Highlights persist across tests in this file: compare against what was there before.
  const all = () => getAnnotations('moby').highlights.map((h) => [h.b, h.text, h.color]);
  let before: unknown[] = [];
  const highlights = () => all().filter((h) => !before.some((x) => JSON.stringify(x) === JSON.stringify(h)));
  beforeEach(() => (before = all()));

  it('Highlight in the bottom menu, then drag over text: highlighted live, saved on release', async () => {
    await openBook();
    fireEvent.press(shown(P1)[0], { nativeEvent: { pageX: W / 2, pageY: 300 } });
    fireEvent.press(screen.getByLabelText('Highlight'));
    expect(screen.getByText('Drag over text')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Highlight colour green'));
    layOut();
    const layer = screen.getByTestId('highlight-layer');

    // From the first word of P1 to the first word of P2.
    fireEvent(layer, 'responderGrant', ev(22, 65));
    fireEvent(layer, 'responderMove', ev(60, 100));
    fireEvent(layer, 'responderMove', ev(22, 125));
    // While dragging, P1 is drawn with the highlight colour behind it.
    const live = screen.UNSAFE_root.findAll((n) => n.props.children === 'Call' || (typeof n.props.children === 'string' && n.props.children.startsWith('Call me')));
    expect(live.some((n) => [n.props.style].flat().some((st: { backgroundColor?: string } | null) => st?.backgroundColor))).toBe(true);
    expect(highlights()).toEqual([]); // nothing saved until the finger lifts

    fireEvent(layer, 'responderRelease', ev(22, 125));
    expect(highlights()).toEqual([
      [1, P1, 'green'],
      [2, 'It', 'green'],
    ]);
  }, 30000);

  it('a tap on a word highlights it; a tap on a highlight opens it; Done turns the tool off', async () => {
    await openBook();
    fireEvent.press(shown(P1)[0], { nativeEvent: { pageX: W / 2, pageY: 300 } });
    fireEvent.press(screen.getByLabelText('Highlight'));
    layOut();
    const layer = screen.getByTestId('highlight-layer');
    // A word on P2's first line (the outer 12% of the screen still turns pages).
    const x = W * 0.7;
    fireEvent(layer, 'responderGrant', ev(x, 125));
    fireEvent(layer, 'responderRelease', ev(x, 125));
    const added = highlights();
    expect(added).toHaveLength(1);
    expect(String(added[0][1]).split(' ')).toHaveLength(1); // one word
    expect(added[0][2]).toBe('green'); // the colour picked last time is remembered

    // Tapping it again (now a highlight) opens the selection sheet for it.
    fireEvent(layer, 'responderGrant', ev(x, 125));
    fireEvent(layer, 'responderRelease', ev(x, 125));
    await waitFor(() => expect(screen.getByText(/Tap words to extend/)).toBeTruthy());

    fireEvent.press(screen.getByLabelText('Done highlighting'));
    expect(screen.queryByTestId('highlight-layer')).toBeNull();
  }, 30000);
});

describe('tap zones', () => {
  it('the first time, a guide shows the zones; a tap dismisses it for good', async () => {
    setSettings({ seenTapZones: false });
    await openBook();
    expect(screen.getByText('Menu')).toBeTruthy();
    expect(screen.getAllByText('Next page').length).toBe(1);
    fireEvent.press(screen.getByLabelText('Got it'));
    expect(screen.queryByText('Menu')).toBeNull();
  }, 30000);

  it('a tap a bit right of the middle opens the menu; one near the right edge does not', async () => {
    await openBook();
    // Right zone: next page (this short book has none), never the menu.
    fireEvent.press(shown(P1)[0], { nativeEvent: { pageX: W * 0.8, pageY: 300 } });
    expect(screen.queryByLabelText('Display')).toBeNull();
    // A bit right of the middle: the menu.
    fireEvent.press(shown(P1)[0], { nativeEvent: { pageX: W * 0.6, pageY: 300 } });
    expect(screen.getByLabelText('Display')).toBeTruthy();
  }, 30000);
});

describe('page numbers, back after a jump, auto page turn', () => {
  it('the footer shows the page number', async () => {
    await openBook();
    await waitFor(() => expect(screen.getByText(/^1 of 1 · /)).toBeTruthy(), { timeout: 3000 });
  }, 30000);

  it('after jumping from the contents, a chip goes back to where you were', async () => {
    await openBook();
    fireEvent.press(shown(P1)[0], { nativeEvent: { pageX: W / 2, pageY: 300 } });
    fireEvent.press(screen.getByLabelText('Contents'));
    // "Loomings" is also the page header and the heading; the contents entry is drawn last.
    const entries = await screen.findAllByText('Loomings');
    fireEvent.press(entries[entries.length - 1]);
    const chip = await screen.findByLabelText(/^Back to page \d+$/);
    fireEvent.press(chip);
    await waitFor(() => expect(screen.queryByLabelText(/^Back to page/)).toBeNull());
  }, 30000);

  it('auto page turn: started from the menu, speed, pause and stop', async () => {
    await openBook();
    fireEvent.press(shown(P1)[0], { nativeEvent: { pageX: W / 2, pageY: 300 } });
    fireEvent.press(screen.getByLabelText('Auto page turn'));
    const speed = () => Number(/(\d+) wpm/.exec(screen.getByText(/\d+ wpm/).props.children.join(''))?.[1]);
    const before = speed();
    fireEvent.press(screen.getByLabelText('Faster'));
    expect(speed()).toBeGreaterThan(before);
    fireEvent.press(screen.getByLabelText('Pause'));
    expect(screen.getByLabelText('Resume')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Stop'));
    expect(screen.queryByText(/\d+ wpm/)).toBeNull();
  }, 30000);

  it('auto-scroll stops by itself at the end of the book', async () => {
    setSettings({ mode: 'scroll' });
    await openBook();
    // A tap in scroll mode: touch down and up in place.
    const root = screen.UNSAFE_root.findAll((n) => typeof n.props.onTouchStart === 'function')[0];
    const touch = { nativeEvent: { pageX: W / 2, pageY: 300 } };
    fireEvent(root, 'touchStart', touch);
    fireEvent(root, 'touchEnd', touch);
    fireEvent.press(await screen.findByLabelText('Auto-scroll'));
    expect(screen.getByText(/\d+ wpm/)).toBeTruthy();
    // The whole (short) book is on screen: the list can't move, so it's the end.
    await waitFor(() => expect(screen.queryByText(/\d+ wpm/)).toBeNull(), { timeout: 4000 });
  }, 30000);
});

describe('Android back button', () => {
  // The reader's back listener; React Navigation's own one (leaving the screen) runs only if it returns false.
  let back: () => boolean | null | undefined = () => false;
  beforeEach(() => {
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, handler) => {
      back = handler as unknown as () => boolean;
      return { remove: () => {} };
    });
  });
  afterEach(() => jest.restoreAllMocks());
  const press = () => {
    let handled: boolean | null | undefined;
    act(() => {
      handled = back();
    });
    return handled;
  };

  it('closes the Display panel, or the menu, before leaving the book', async () => {
    await openBook();
    fireEvent.press(shown(P1)[0], { nativeEvent: { pageX: W / 2, pageY: 300 } });
    fireEvent.press(screen.getByLabelText('Display'));
    expect(press()).toBe(true); // closes the panel (it slides away; animations don't finish in tests)
    expect(press()).toBe(false); // and with it the menu: nothing is open, back leaves the book
    fireEvent.press(shown(P1)[0], { nativeEvent: { pageX: W / 2, pageY: 300 } });
    expect(screen.getByLabelText('Contents')).toBeTruthy();
    expect(press()).toBe(true); // closes the menu
    expect(press()).toBe(false);
  }, 30000);

  it('turns the highlight tool off, and stops auto page turn', async () => {
    await openBook();
    fireEvent.press(shown(P1)[0], { nativeEvent: { pageX: W / 2, pageY: 300 } });
    fireEvent.press(screen.getByLabelText('Highlight'));
    expect(screen.getByTestId('highlight-layer')).toBeTruthy();
    expect(press()).toBe(true);
    expect(screen.queryByTestId('highlight-layer')).toBeNull();
    fireEvent.press(shown(P1)[0], { nativeEvent: { pageX: W / 2, pageY: 300 } });
    fireEvent.press(screen.getByLabelText('Auto page turn'));
    expect(screen.getByText(/\d+ wpm/)).toBeTruthy();
    expect(press()).toBe(true);
    expect(screen.queryByText(/\d+ wpm/)).toBeNull();
  }, 30000);
});

describe('the end of the book', () => {
  it('turning past the last page marks the book finished and says so', async () => {
    mockUpdateBook.mockClear();
    await openBook();
    // Opening on the last page isn't finishing it.
    expect(mockUpdateBook.mock.calls.some(([, patch]) => patch.finished)).toBe(false);
    fireEvent.press(shown(P1)[0], { nativeEvent: { pageX: W * 0.9, pageY: 300 } }); // next page: there is none
    expect(await screen.findByLabelText('Finished · Back to library')).toBeTruthy();
    expect(mockUpdateBook).toHaveBeenCalledWith('moby', { finished: true });
  }, 30000);
});

describe('getting around from the menu', () => {
  it('Go to page takes a page number or a percentage, and says what to type otherwise', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    render(
      <>
        <ReaderScreen />
        <DialogHost />
      </>,
    );
    await waitFor(() => expect(shown(P1).length).toBeGreaterThan(0), { timeout: 9000 });
    fireEvent.press(shown(P1)[0], { nativeEvent: { pageX: W / 2, pageY: 300 } });
    await waitFor(() => expect(screen.getByText(/^1 of 1 · /)).toBeTruthy(), { timeout: 3000 });
    fireEvent.press(screen.getByLabelText('Go to page'));
    fireEvent.changeText(screen.getByPlaceholderText('Page 1–1, or a percentage like 45%'), '7');
    fireEvent.press(screen.getByText('Go'));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Enter a page from 1 to 1, or a percentage.'));
    alert.mockRestore();
  }, 30000);

  it('chapter buttons: none before the first chapter or after the last', async () => {
    await openBook();
    fireEvent.press(shown(P1)[0], { nativeEvent: { pageX: W / 2, pageY: 300 } });
    // The book has one chapter, starting where it opens.
    expect(screen.getByLabelText('Previous chapter').props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByLabelText('Next chapter').props.accessibilityState?.disabled).toBe(true);
  }, 30000);
});

