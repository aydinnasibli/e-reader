// Touches on the page. Page mode: a swipe turns the page (following the
// finger), a tap on an edge turns it too, a tap in the middle opens the menu.
// Scroll mode: the WebView scrolls itself; a tap opens the menu. A long press
// selects the word under the finger (selection.ts): moving on without lifting
// it takes in more words, and the selection's handles move its ends. With text
// selected, a tap only ends the selection. With the highlight tool, touches
// mark text instead.

import { TAP_SLOP, swipeOutcome, tapZone } from '../../gestures';
import { send } from './bridge';
import { type Handle, clearSelection, dragTo, extendTo, grab, handleAt, letGo, selectWordAt, selected } from './selection';
import { pointAtScreen } from './text';

export interface TouchTarget {
  mode: 'page' | 'scroll';
  tapForward: boolean;
  turn(dir: 1 | -1): void;
  drag(dx: number): void;
  springBack(): void;
  followsFinger: boolean;
  /** Scroll mode: a touch while auto-scrolling. */
  touched(): void;
}

/** Held this long without moving, a touch is a long press: it selects. */
const LONG_PRESS_MS = 450;
/** Moving more than this (points) before then, the finger isn't pressing: it scrolls or swipes. */
const PRESS_SLOP = 10;
/** Scroll mode: the selection moved this close to the top or bottom of the screen scrolls the text on. */
const EDGE = 56;

export function handleTouches(target: () => TouchTarget, marking: () => boolean) {
  let start = { x: 0, y: 0, t: 0 };
  let last = { x: 0, t: 0, vx: 0 };
  /** Which way the finger went: 'h' a swipe (ours), 'v' anything else (the browser's: scrolling). */
  let axis: 'h' | 'v' | null = null;
  /** The touch began with text selected: it's for the selection (a tap ends it). */
  let forSelection = false;
  /** Two fingers were down (a pinch, a resting thumb): neither a turn nor a tap. */
  let multi = false;
  /** What the touch moves: a handle of the selection, or the words its long press selected. */
  let grip: Handle | 'words' | null = null;
  let press: ReturnType<typeof setTimeout> | null = null;
  let markFrom: ReturnType<typeof pointAtScreen> = null;
  let moved = false;
  let frame = 0;
  let finger = { x: 0, y: 0 };
  let edgeFrame = 0;

  const linkAt = (el: EventTarget | null) => (el instanceof Element ? (el.closest('[data-link]') as HTMLElement | null) : null);
  const unpress = () => {
    if (press) clearTimeout(press);
    press = null;
  };

  /** The selection's end follows the finger; near the top or bottom in scroll mode, the text scrolls on under it. */
  const follow = (x: number, y: number) => {
    finger = { x, y };
    if (grip === 'words') extendTo(x, y);
    else if (grip) dragTo(x, y);
    if (target().mode === 'scroll' && !edgeFrame && (y < EDGE || y > window.innerHeight - EDGE)) edgeFrame = requestAnimationFrame(edgeScroll);
  };
  const edgeScroll = () => {
    edgeFrame = 0;
    if (!grip) return;
    const { x, y } = finger;
    const step = y < EDGE ? -(EDGE - y) / 4 : y > window.innerHeight - EDGE ? (y - window.innerHeight + EDGE) / 4 : 0;
    const was = window.scrollY;
    if (step) window.scrollBy(0, Math.sign(step) * Math.ceil(Math.abs(step)));
    if (window.scrollY !== was) follow(x, y);
  };

  document.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length > 1) {
        multi = true;
        unpress();
        if (grip) {
          grip = null;
          letGo();
        }
        if (axis === 'h') target().springBack();
        return;
      }
      const p = e.touches[0];
      start = { x: p.clientX, y: p.clientY, t: performance.now() };
      last = { x: p.clientX, t: start.t, vx: 0 };
      axis = null;
      moved = false;
      multi = false;
      unpress();
      forSelection = selected();
      grip = forSelection && !marking() ? handleAt(p.clientX, p.clientY) : null;
      if (grip) grab(grip, p.clientX, p.clientY);
      target().touched();
      if (marking()) markFrom = pointAtScreen(p.clientX, p.clientY);
      else if (!grip) {
        press = setTimeout(() => {
          press = null;
          if (axis === 'h' || !selectWordAt(start.x, start.y)) return;
          grip = 'words';
          forSelection = false;
        }, LONG_PRESS_MS);
      }
    },
    { passive: true },
  );

  document.addEventListener(
    'touchmove',
    (e) => {
      const p = e.touches[0];
      const dx = p.clientX - start.x;
      const dy = p.clientY - start.y;
      const now = performance.now();
      last = { x: p.clientX, t: now, vx: now > last.t ? (p.clientX - last.x) / (now - last.t) : last.vx };
      if (marking()) {
        // The marker pen: the page neither scrolls nor turns.
        e.preventDefault();
        if (multi || (!moved && Math.hypot(dx, dy) < 8)) return;
        moved = true;
        const x = p.clientX;
        const y = p.clientY;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => send({ t: 'markDrag', from: markFrom, to: pointAtScreen(x, y), done: false }));
        return;
      }
      if (grip) {
        // Moving the selection: the page neither scrolls nor turns.
        e.preventDefault();
        follow(p.clientX, p.clientY);
        return;
      }
      if (press && Math.hypot(dx, dy) > PRESS_SLOP) unpress();
      const t = target();
      if (forSelection || multi || t.mode !== 'page') return;
      if (!axis && Math.hypot(dx, dy) > 10) axis = Math.abs(dx) > Math.abs(dy) * 1.5 ? 'h' : 'v';
      if (axis === 'h') {
        // Ours: the page follows the finger.
        e.preventDefault();
        if (t.followsFinger) t.drag(dx);
      }
    },
    { passive: false },
  );

  const end = (e: TouchEvent, cancelled: boolean) => {
    unpress();
    if (grip) {
      grip = null;
      letGo();
      return;
    }
    if (multi) {
      // Once the last finger is up, the next touch is a fresh one.
      if (!e.touches.length) multi = false;
      if (marking() && moved) {
        moved = false;
        cancelAnimationFrame(frame);
        send({ t: 'markDrag', from: null, to: null, done: true });
      }
      return;
    }
    const p = e.changedTouches[0];
    const dx = p.clientX - start.x;
    const dy = p.clientY - start.y;
    const t = target();
    const held = performance.now() - start.t;
    if (marking()) {
      cancelAnimationFrame(frame);
      if (cancelled) return send({ t: 'markDrag', from: null, to: null, done: true });
      if (moved) return send({ t: 'markDrag', from: markFrom, to: pointAtScreen(p.clientX, p.clientY), done: true });
      // A tap: the outer edges still turn pages.
      const w = window.innerWidth;
      if (t.mode === 'page' && p.clientX < w * 0.12) return t.turn(t.tapForward ? 1 : -1);
      if (t.mode === 'page' && p.clientX > w * 0.88) return t.turn(1);
      return send({ t: 'markTap', at: pointAtScreen(p.clientX, p.clientY) });
    }
    if (cancelled) {
      if (axis === 'h') t.springBack();
      return;
    }
    if (axis === 'h') {
      const outcome = swipeOutcome(dx, last.vx, window.innerWidth);
      if (outcome === 'next') t.turn(1);
      else if (outcome === 'prev') t.turn(-1);
      else t.springBack();
      return;
    }
    // A tap: not a long press, not a scroll.
    const tap = held < LONG_PRESS_MS && Math.hypot(dx, dy) < TAP_SLOP;
    // With text selected, a tap ends the selection and does nothing else.
    if (forSelection) {
      if (tap) clearSelection();
      return;
    }
    if (!tap) return;
    const link = linkAt(e.target);
    if (link) return send({ t: 'link', target: link.dataset.link! });
    if (t.mode === 'scroll') return send({ t: 'tap' });
    const zone = tapZone(p.clientX, window.innerWidth);
    if (zone === 'prev') t.turn(t.tapForward ? 1 : -1);
    else if (zone === 'next') t.turn(1);
    else send({ t: 'tap' });
  };
  document.addEventListener('touchend', (e) => end(e, false));
  document.addEventListener('touchcancel', (e) => end(e, true));
}
