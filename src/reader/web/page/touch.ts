// Touches on the page. Page mode: a swipe turns the page (following the
// finger), a tap on an edge turns it too, a tap in the middle opens the menu.
// Scroll mode: the WebView scrolls itself; a tap opens the menu. A long press
// is the browser's own: it selects the word with real handles. With the
// highlight tool, touches mark text instead.

import { TAP_SLOP, swipeOutcome, tapZone } from '../../gestures';
import { send } from './bridge';
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

/** Held this long, it's the browser's long press (selecting), not a tap. */
const LONG_PRESS_MS = 450;

const hasSelection = () => {
  const s = document.getSelection();
  return !!s && s.rangeCount > 0 && !s.isCollapsed;
};

export function handleTouches(target: () => TouchTarget, marking: () => boolean) {
  let start = { x: 0, y: 0, t: 0 };
  let last = { x: 0, t: 0, vx: 0 };
  let axis: 'h' | 'v' | null = null;
  /** The touch began with text selected: it's for the selection (the browser's). */
  let forSelection = false;
  let markFrom: ReturnType<typeof pointAtScreen> = null;
  let moved = false;
  let frame = 0;

  const linkAt = (el: EventTarget | null) => (el instanceof Element ? (el.closest('[data-link]') as HTMLElement | null) : null);

  document.addEventListener(
    'touchstart',
    (e) => {
      const p = e.touches[0];
      start = { x: p.clientX, y: p.clientY, t: performance.now() };
      last = { x: p.clientX, t: start.t, vx: 0 };
      axis = null;
      moved = false;
      forSelection = hasSelection();
      target().touched();
      if (marking()) markFrom = pointAtScreen(p.clientX, p.clientY);
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
        if (!moved && Math.hypot(dx, dy) < 8) return;
        moved = true;
        const x = p.clientX;
        const y = p.clientY;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => send({ t: 'markDrag', from: markFrom, to: pointAtScreen(x, y), done: false }));
        return;
      }
      const t = target();
      if (forSelection || t.mode !== 'page') return;
      if (!axis && Math.hypot(dx, dy) > 10) axis = Math.abs(dx) > Math.abs(dy) * 1.5 ? 'h' : 'v';
      if (axis === 'h') {
        // Ours: no selecting while swiping.
        e.preventDefault();
        if (t.followsFinger) t.drag(dx);
      }
    },
    { passive: false },
  );

  const end = (e: TouchEvent, cancelled: boolean) => {
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
    // A tap: not a long press, not with text selected (the browser ends the selection).
    if (forSelection || hasSelection() || held >= LONG_PRESS_MS || Math.hypot(dx, dy) >= TAP_SLOP) return;
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
