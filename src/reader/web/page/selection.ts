// Text selected on the page. The page's own selection, not the browser's: the
// book's text can't be selected (base.css), so the phone never puts a menu of
// its own over it (Copy, Look Up, Speak...); the screen shows its own menu.
// A long press selects the word under the finger, and moving on without
// lifting it takes in more words; a handle at each end moves that end. The
// screen is told where the selection starts and ends in the book, and where
// on screen, for the menu over it.

import type { DrawnPoint, PageCaret } from '../protocol';
import { send } from './bridge';
import { charAtScreen, charBox, placeAt, pointAtScreen } from './text';

/** The selection held still this long (a handle dragged, the text scrolled): the screen is told where it is now. */
const SETTLE_MS = 120;
/** A handle answers a touch this far (points) from its line and knob. */
const GRIP = 24;
/** A handle's knob sticks out this far past the line it ends (base.css). */
const KNOB = 12;

/** The first character selected and the place after the last, in reading order. */
interface Sel {
  start: DrawnPoint;
  end: DrawnPoint;
}

export type Handle = 'start' | 'end';

let sel: Sel | null = null;
/** The screen was told of the selection, so it's told when it ends. */
let told = false;
let timer: ReturnType<typeof setTimeout> | null = null;
/** The word a long press selected: moving on from it takes in whole words. */
let pressed: Sel | null = null;
/** A handle being dragged, and where its line's middle is from the finger. */
let held: { h: Handle; dx: number; dy: number } | null = null;

const before = (p: DrawnPoint, q: DrawnPoint) => p.b < q.b || (p.b === q.b && p.i < q.i);
const blockEl = (b: number) => document.querySelector<HTMLElement>(`[data-b="${b}"]`);

export const selected = () => sel !== null;

let segmenter: { lang: string; words: Intl.Segmenter } | null = null;
/** The book language's word breaks (Chrome 87+, Safari 14.1+). */
function wordBreaks(): Intl.Segmenter | null {
  if (typeof Intl.Segmenter !== 'function') return null;
  const lang = document.documentElement.lang || 'en';
  if (segmenter?.lang !== lang) segmenter = { lang, words: new Intl.Segmenter(lang, { granularity: 'word' }) };
  return segmenter.words;
}
const WORD_CHAR = /[\p{L}\p{N}\p{M}­'’_]/u;

/** The word around character `c` of `text`, [s, e): off words, that one character; null on a space. */
function wordAt(text: string, c: number): { s: number; e: number } | null {
  if (c < 0 || c >= text.length || /\s/.test(text[c])) return null;
  const words = wordBreaks();
  if (words) {
    const w = words.segment(text).containing(c);
    if (w && /\S/.test(w.segment)) return { s: w.index, e: w.index + w.segment.length };
  }
  if (!WORD_CHAR.test(text[c])) return { s: c, e: c + 1 };
  let s = c;
  let e = c + 1;
  while (s > 0 && WORD_CHAR.test(text[s - 1])) s--;
  while (e < text.length && WORD_CHAR.test(text[e])) e++;
  return { s, e };
}

/**
 * The place nearest a point on screen, if it's on screen: in page mode, a
 * point in a margin can be nearest the text of the page before or after,
 * out of sight.
 */
function placeAtScreen(x: number, y: number): DrawnPoint | null {
  const p = pointAtScreen(x, y);
  const el = p && blockEl(p.b);
  if (!p || !el) return null;
  const box = charBox(el, p.i) ?? charBox(el, p.i - 1);
  return !box || (box.right > 0 && box.left < window.innerWidth) ? p : null;
}

/** A long press: the word under the finger selected. Whether there was one. */
export function selectWordAt(x: number, y: number): boolean {
  const at = charAtScreen(x, y);
  if (!at) return false;
  const text = at.el.textContent ?? '';
  const w = wordAt(text, at.c) ?? wordAt(text, at.c - 1) ?? wordAt(text, at.c + 1);
  if (!w) return false;
  pressed = { start: { b: at.b, i: w.s }, end: { b: at.b, i: w.e } };
  set(pressed, true);
  return true;
}

/** The finger moved on after a long press: from the word pressed to the word it's on now. */
export function extendTo(x: number, y: number) {
  const p = pressed && placeAtScreen(x, y);
  if (!pressed || !p) return;
  const text = blockEl(p.b)?.textContent ?? '';
  if (before(p, pressed.start)) {
    const w = wordAt(text, p.i);
    set({ start: { b: p.b, i: w ? w.s : p.i }, end: pressed.end });
  } else if (before(pressed.end, p)) {
    const w = wordAt(text, p.i - 1);
    set({ start: pressed.start, end: { b: p.b, i: w ? w.e : p.i } });
  } else set(pressed);
}

/** The handle a touch at a point on screen takes hold of: the nearer one when both are close. */
export function handleAt(x: number, y: number): Handle | null {
  const c = sel && carets(sel);
  if (!c) return null;
  // From the point to a handle: its line, with the knob above it (start) or below it (end).
  const away = (k: PageCaret, top: number, bottom: number) => Math.hypot(x - k.x, y < top ? top - y : y > bottom ? y - bottom : 0);
  const a = away(c.start, c.start.y - KNOB, c.start.y + c.start.h);
  const z = away(c.end, c.end.y, c.end.y + c.end.h + KNOB);
  if (Math.min(a, z) > GRIP) return null;
  return a < z ? 'start' : 'end';
}

/** A handle taken hold of by a finger at a point on screen. */
export function grab(h: Handle, x: number, y: number) {
  const c = sel && carets(sel);
  if (!c) return;
  const k = h === 'start' ? c.start : c.end;
  held = { h, dx: k.x - x, dy: k.y + k.h / 2 - y };
}

/** The handle held, dragged by a finger now at a point on screen. An end never passes the other. */
export function dragTo(x: number, y: number) {
  const p = sel && held && placeAtScreen(x + held.dx, y + held.dy);
  if (!sel || !held || !p) return;
  if (held.h === 'start' && before(p, sel.end)) set({ start: p, end: sel.end });
  else if (held.h === 'end' && before(sel.start, p)) set({ start: sel.start, end: p });
}

/** The finger that moved the selection lifted: the screen is told where it is now. */
export function letGo() {
  held = null;
  pressed = null;
  if (sel) tell(true);
}

export function clearSelection() {
  if (timer) clearTimeout(timer);
  timer = null;
  held = null;
  pressed = null;
  sel = null;
  draw();
  if (told) {
    told = false;
    send({ t: 'noSelection' });
  }
}

/** The text moved under the selection (chunks came or went): drawn where it is now, and the screen told. */
export function refreshSelection() {
  if (!sel) return;
  if (!carets(sel)) return clearSelection();
  draw();
  tell(false);
}

export function watchSelection() {
  // Scroll mode: the selection scrolls with the text (the screen hides its menu meanwhile): where it is now.
  window.addEventListener(
    'scroll',
    () => {
      if (sel) tell(false);
    },
    { passive: true },
  );
  window.addEventListener('resize', refreshSelection);
}

function set(next: Sel, now = false) {
  sel = next;
  draw();
  tell(now);
}

/** Tell the screen where the selection is: now, or once it holds still. */
function tell(now: boolean) {
  if (timer) clearTimeout(timer);
  timer = null;
  if (now) report();
  else timer = setTimeout(report, SETTLE_MS);
}

function report() {
  timer = null;
  const c = sel && carets(sel);
  if (!sel || !c) return;
  told = true;
  send({ t: 'selection', start: sel.start, end: sel.end, startCaret: c.start, endCaret: c.end });
}

/** The boxes of the selected text on screen, a line's boxes in one. */
function boxesOf(s: Sel): { left: number; top: number; width: number; height: number }[] {
  const a = blockEl(s.start.b);
  const z = blockEl(s.end.b);
  if (!a || !z) return [];
  const from = placeAt(a, s.start.i);
  const to = placeAt(z, s.end.i);
  const r = document.createRange();
  r.setStart(from.node, from.offset);
  r.setEnd(to.node, to.offset);
  // Text only: a range's own boxes include the whole box of every paragraph it holds.
  const rects: DOMRect[] = [];
  const part = document.createRange();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  walker.currentNode = r.startContainer;
  for (let n = r.startContainer instanceof Text ? r.startContainer : (walker.nextNode() as Text | null); n; n = walker.nextNode() as Text | null) {
    if (r.comparePoint(n, 0) > 0) break;
    part.setStart(n, n === r.startContainer ? r.startOffset : 0);
    part.setEnd(n, n === r.endContainer ? r.endOffset : n.data.length);
    if (!part.collapsed) for (const b of part.getClientRects()) if (b.width > 0 && b.height > 0) rects.push(b);
  }
  const out: { left: number; top: number; width: number; height: number }[] = [];
  for (const b of rects) {
    const line = out[out.length - 1];
    if (line && Math.abs(line.top - b.top) < 1 && Math.abs(line.height - b.height) < 1 && b.left >= line.left - 1 && b.left <= line.left + line.width + 1) {
      line.width = Math.max(line.width, b.right - line.left);
    } else out.push({ left: b.left, top: b.top, width: b.width, height: b.height });
  }
  return out;
}

/** Where the selection starts and ends on screen; null if its text isn't on the page. */
function carets(s: Sel): { start: PageCaret; end: PageCaret } | null {
  const boxes = boxesOf(s);
  if (!boxes.length) return null;
  const a = boxes[0];
  const z = boxes[boxes.length - 1];
  return { start: { x: a.left, y: a.top, h: a.height }, end: { x: z.left + z.width, y: z.top, h: z.height } };
}

/** The selection drawn over the text: a tint and its handles, in the layer that moves with the text. */
function draw() {
  let el = document.getElementById('sel');
  const boxes = sel ? boxesOf(sel) : [];
  if (!boxes.length) return el?.remove();
  // Page mode: the screen's (pages slide under it, but a selection ends when one turns); scroll mode: the page's.
  const layer = document.getElementById(document.documentElement.dataset.mode === 'page' ? 'viewport' : 'scroll')!;
  if (el?.parentElement !== layer) {
    el?.remove();
    el = document.createElement('div');
    el.id = 'sel';
    layer.appendChild(el);
  }
  const o = layer.getBoundingClientRect();
  const at = (left: number, top: number, width: number, height: number) => `left:${left - o.left}px;top:${top - o.top}px;width:${width}px;height:${height}px`;
  const a = boxes[0];
  const z = boxes[boxes.length - 1];
  el.innerHTML =
    boxes.map((b) => `<div class="box" style="${at(b.left, b.top, b.width, b.height)}"></div>`).join('') +
    `<div class="knob a" style="${at(a.left - 1, a.top, 2, a.height)}"></div>` +
    `<div class="knob z" style="${at(z.left + z.width - 1, z.top, 2, z.height)}"></div>`;
}
