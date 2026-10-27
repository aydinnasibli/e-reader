// @vitest-environment jsdom
// The page inside the reader's WebView (src/reader/web/page) in a DOM without
// layout (jsdom): what it tells the screen as layouts and views come and go,
// and what it hides meanwhile. Where the text is drawn is tested in real
// browser engines (bench/webpage).

import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { FromPage, ToPage } from '@/reader/web/protocol';

const told: FromPage[] = [];
let tell: (m: ToPage) => void;

beforeAll(async () => {
  document.body.innerHTML = '<div id="viewport"></div><div id="scroll"></div>';
  document.head.innerHTML = '<style id="fonts"></style><style id="book"></style>';
  // What jsdom leaves out: font loading, layout boxes of ranges, size watching.
  Object.defineProperty(document, 'fonts', { value: { forEach() {}, ready: Promise.resolve() } });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  (window as unknown as { ReactNativeWebView: unknown }).ReactNativeWebView = { postMessage: (d: string) => told.push(JSON.parse(d)) };
  setWidth(400);
  await import('@/reader/web/page/main');
  tell = (window as unknown as { __nec: (m: ToPage) => void }).__nec;
});

/** Everything sent so far handled (each message waits for the one before). */
const handled = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** The WebView's width as the page sees it. */
function setWidth(w: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
}
const resized = (w: number) => {
  setWidth(w);
  window.dispatchEvent(new Event('resize'));
};
const hidden = () => document.documentElement.classList.contains('relayout');

const frame = { width: 400, height: 700, left: 20, right: 20, top: 0, bottom: 0, column: 360, gap: 40, spread: false };
const setup = (mode: 'page' | 'scroll', key: string, width = 400): ToPage => ({
  t: 'setup',
  key,
  target: { at: { b: 0, i: 0 } },
  setup: { mode, frame: { ...frame, width }, css: '', turn: 'none', tapForward: false, processing: '', theEnd: '' },
});
const shownKeys = (from: number) => told.slice(from).flatMap((m) => (m.t === 'shown' ? [m.key] : []));

describe('the phone turned', () => {
  it('the text is hidden from the moment the width changes until it is laid out for the new one, and 10 s at most', async () => {
    tell(setup('page', 'p#1'));
    tell({ t: 'bounds', count: 1, complete: true });
    tell({ t: 'content', key: 'p#1', target: { at: { b: 0, i: 0 } }, chunks: [{ c: 0, chars: 5, html: '<p data-b="0" class="p">Hello</p>' }] });
    await handled();
    expect(hidden()).toBe(false);
    // The WebView is wider now: the old layout isn't shown in it.
    resized(800);
    expect(hidden()).toBe(true);
    // A layout for the old width (sent before the screen heard) leaves it hidden; one for the new width shows it.
    tell(setup('page', 'p#2', 400));
    await handled();
    expect(hidden()).toBe(true);
    tell(setup('page', 'p#3', 800));
    await handled();
    expect(hidden()).toBe(false);
    // A change of height only: nothing hidden.
    resized(800);
    expect(hidden()).toBe(false);
    // Turned back, and the screen never sends a layout: shown again after a while whatever happens.
    vi.useFakeTimers();
    try {
      resized(400);
      expect(hidden()).toBe(true);
      vi.advanceTimersByTime(10_000);
      expect(hidden()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    tell(setup('page', 'p#4', 400));
    await handled();
  });

  it('a layout already replaced by one waiting behind it is skipped, and so is measuring for it', async () => {
    const before = told.length;
    tell(setup('page', 'p#5'));
    tell(setup('page', 'p#6'));
    await handled();
    expect(shownKeys(before)).toEqual(['p#6']);
    // Measuring a layout takes the page a while: not when a new layout is waiting.
    const chunk = { c: 0, chars: 5, html: '<p data-b="0" class="p">Hello</p>' };
    const measured = () => told.slice(before).filter((m) => m.t === 'measured');
    tell({ t: 'measure', key: 'p#6', chunks: [chunk] });
    tell(setup('page', 'p#7'));
    await handled();
    expect(measured()).toEqual([]);
    // With none waiting, or only one that changes no layout (the colours: the same key), it's measured.
    tell({ t: 'measure', key: 'p#7', chunks: [chunk, { ...chunk, c: 1 }] });
    tell(setup('page', 'p#7'));
    await handled();
    expect(measured()).toEqual([{ t: 'measured', key: 'p#7', counts: [expect.objectContaining({ c: 0 }), expect.objectContaining({ c: 1 })] }]);
  });
});

describe('a view left behind by a change of mode', () => {
  it('says nothing more: a picture of the page view loading late lays out nothing and reports no place', async () => {
    tell(setup('page', 'paged#1'));
    tell({ t: 'bounds', count: 1, complete: true });
    tell({ t: 'content', key: 'paged#1', target: { at: { b: 0, i: 0 } }, chunks: [{ c: 0, chars: 5, html: '<p data-b="0" class="p">Hello</p><div data-b="1" class="img"><img src="x.png" width="10" height="10"></div>' }] });
    await handled();
    expect(told.some((m) => m.t === 'shown' && m.key === 'paged#1')).toBe(true);
    const picture = document.querySelector('img')!;
    // Scroll mode now: the page view is replaced, its picture still loading.
    tell(setup('scroll', 'scrolled#1'));
    await handled();
    const before = told.length;
    vi.useFakeTimers();
    try {
      picture.dispatchEvent(new Event('load'));
      vi.advanceTimersByTime(200);
    } finally {
      vi.useRealTimers();
    }
    expect(told.slice(before).filter((m) => m.t === 'shown')).toEqual([]);
  });
});
