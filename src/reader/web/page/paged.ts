// Page mode. The chunks around the place read sit side by side on a strip
// that slides one screen per page turn, each laid out in CSS columns one page
// apart (two to a screen in a spread). Only those chunks are on the strip, so
// page 30,000 of a 100 MB book costs what page 3 does.
//
// Two chunks cut apart only for size (Chunk.joins) are laid out as one flow,
// a unit, so the first one's last page is filled with the start of the
// second. A page belongs to the chunk of its first character. A unit whose
// first chunk isn't here yet is laid out without it, and isn't shown (nor
// counted) until it comes; a unit's first chunk dropped by the screen stays
// while the second is still read, so the second's pages don't move.

import type { Chunk, DrawnPoint, PageFrame, PageSetup, Target } from '../protocol';
import { send } from './bridge';
import { draw as drawMarks } from './marks';
import { clearFlash, flashLine } from './flash';
import { blocksIn, charBox, lengthOf, partAt } from './text';

/** A chunk on the strip. */
interface Part {
  c: number;
  html: string;
  chars: number;
  /** Goes on from chunk c - 1 (Chunk.joins). */
  joins: boolean;
  /** Its first block. */
  first: number;
  /** The screen has it: false once dropped while the chunk after it, laid out on from it, is still read. */
  live: boolean;
}

/** Chunks laid out as one flow: one chunk, or two where the second goes on from the first. */
interface Unit {
  parts: Part[];
  el: HTMLElement;
  /** Laid out without the chunk it goes on from, which isn't here yet: not shown until it is. */
  partial: boolean;
  /** Text columns (pages) and screens it takes. */
  cols: number;
  screens: number;
  /** Screens before it on the strip. */
  offset: number;
  /** The column each part's own pages start at (a page belongs to the chunk of its first character). */
  starts: number[];
}

const SLIDE_MS = 220;
/**
 * Paragraphs of up to this many lines aren't split between pages: the
 * engines keep two lines at a page's foot (orphans) but leave one alone at
 * the next page's top (widows) rather than move a three-line paragraph whole.
 */
const KEEP_LINES = 3;

const firstBlock = (html: string) => Number(/data-b="(\d+)"/.exec(html)?.[1] ?? -1);

export class Paged {
  private strip: HTMLElement;
  private parts = new Map<number, Part>();
  private units: Unit[] = [];
  /** The screen shown, counted along the strip. */
  private screen = 0;
  private frame!: PageFrame;
  private setup!: PageSetup;
  private key = '';
  private count = 0;
  private complete = false;
  private animating = false;
  /** Waiting for a page turn to land (see idle). */
  private landed: (() => void)[] = [];
  /** A place asked for that isn't on the strip yet (shown when its chunk comes, unless another is shown first). */
  private waiting: Target | null = null;
  /** The place arrived at (opened, jumped to, turned to): kept when the page lays itself out again. */
  private arrived: DrawnPoint | null = null;
  private watched = new WeakSet<HTMLImageElement>();

  constructor(private viewport: HTMLElement) {
    this.strip = document.createElement('div');
    this.strip.id = 'strip';
    viewport.appendChild(this.strip);
    // A selection dragged to the edge must not scroll the page sideways.
    viewport.addEventListener('scroll', () => {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    });
  }

  /**
   * Resolves once no page turn is sliding. Messages that move the strip wait
   * for it: a chunk added or dropped mid-slide would shift the strip under
   * the screen the turn is going to, and the turn would land a chunk away.
   */
  async idle(): Promise<void> {
    // (A tap can land one turn and start the next in the same moment: wait for that one too.)
    while (this.animating) await new Promise<void>((r) => this.landed.push(r));
  }

  get perScreen() {
    return this.frame.spread ? 2 : 1;
  }

  /** How far the strip moves a screen: pages are drawn between the notch and the camera. */
  private get screenWidth() {
    const inset = this.frame.inset;
    return this.frame.width - (inset ? inset.left + inset.right : 0);
  }

  /** How far one page is from the next. */
  private get pitch() {
    return this.frame.column + this.frame.gap;
  }

  configure(setup: PageSetup, key: string, target: Target) {
    const same = !!this.frame && key === this.key && JSON.stringify(this.frame) === JSON.stringify(setup.frame);
    this.setup = setup;
    this.frame = setup.frame;
    this.key = key;
    // Only the colours, the turn or the tap side changed: the pages stay as they are.
    if (same) return;
    clearFlash();
    this.measure();
    this.show(target, false);
  }

  setContent(chunks: Chunk[], target: Target, key: string) {
    this.key = key;
    this.waiting = null;
    clearFlash();
    this.strip.textContent = '';
    this.units = [];
    this.parts.clear();
    this.insert(chunks);
    this.show(target, false);
  }

  add(chunks: Chunk[]) {
    const here = this.shownPoint();
    this.insert(chunks);
    // Chunks added before the one shown push it along the strip: stay on it.
    this.keep(here);
    if (this.waiting) {
      const t = this.waiting;
      this.waiting = null;
      this.show(t, false);
    } else this.report(false);
  }

  drop(cs: number[]) {
    const gone = cs.map((c) => this.parts.get(c)).filter((p): p is Part => !!p);
    if (!gone.length) return;
    const here = this.shownPoint();
    for (const p of gone) p.live = false;
    const units: Unit[] = [];
    for (const u of this.units) {
      if (u.parts.every((p) => !p.live)) {
        u.el.remove();
        for (const p of u.parts) this.parts.delete(p.c);
        continue;
      }
      // The second chunk of two going: the first's pages stay as they are.
      const second = u.parts[1];
      if (second && !second.live) {
        removeFrom(u.el, second.first);
        u.parts = [u.parts[0]];
        this.parts.delete(second.c);
        this.measureUnit(u);
      }
      units.push(u);
    }
    this.units = units;
    this.layoutStrip();
    this.keep(here);
  }

  bounds(count: number, complete: boolean) {
    this.count = count;
    this.complete = complete;
  }

  go(target: Target) {
    this.show(target, false);
  }

  /**
   * How many pages chunks take in this layout, each on its own (for page
   * numbers: chunks of the book's body, wherever it was opened). Laid out on
   * the strip as they would be and taken off again before anything is drawn:
   * the pages shown, a selection and marks stay as they are.
   */
  measureChunks(key: string, chunks: Chunk[]) {
    if (key !== this.key || !this.frame) return;
    const counts: { c: number; pages: number }[] = [];
    for (const ch of chunks) {
      const el = document.createElement('section');
      el.className = 'chunk';
      const u: Unit = { parts: [{ c: ch.c, html: ch.html, chars: ch.chars, joins: false, first: firstBlock(ch.html), live: false }], el, partial: false, cols: 1, screens: 1, offset: 0, starts: [0] };
      el.innerHTML = ch.html;
      this.strip.appendChild(el);
      this.measureUnit(u);
      el.remove();
      counts.push({ c: ch.c, pages: u.cols });
    }
    send({ t: 'measured', key, counts });
  }

  /**
   * A page turn (a tap, a swipe, auto page turn). One that comes while the
   * last still slides lands that one at once and goes on: every tap counts.
   */
  turn(dir: 1 | -1) {
    this.finish?.();
    clearFlash();
    const to = this.screen + dir;
    if (!this.open(to)) return this.edge(dir);
    this.animateTo(to);
  }

  // ---- the strip ----

  private totalScreens() {
    const last = this.units[this.units.length - 1];
    return last ? last.offset + last.screens : 0;
  }

  /** Where screen `screen` is: its unit, its (first) page's column in it, and the part that page belongs to. */
  private at(screen: number) {
    const u = this.units.find((x) => screen >= x.offset && screen < x.offset + x.screens);
    if (!u) return null;
    const col = (screen - u.offset) * this.perScreen;
    let k = 0;
    while (k + 1 < u.starts.length && u.starts[k + 1] <= col) k++;
    return { u, col, k, part: u.parts[k] };
  }

  /** A screen that can be shown: its chunk is one the screen has, laid out as it will stay. */
  private open(screen: number) {
    const a = this.at(screen);
    return !!a && !a.u.partial && a.part.live;
  }

  /** The chunk it takes to show screen `screen` (null: none, or it's there). */
  private wanted(screen: number): number | null {
    const a = this.at(screen);
    if (!a) return null;
    if (a.u.partial) return a.u.parts[0].c - 1;
    return a.part.live ? null : a.part.c;
  }

  private insert(chunks: Chunk[]) {
    for (const ch of chunks) {
      const had = this.parts.get(ch.c);
      if (had) had.live = true;
      else this.parts.set(ch.c, { c: ch.c, html: ch.html, chars: ch.chars, joins: !!ch.joins, first: firstBlock(ch.html), live: true });
    }
    this.regroup();
  }

  /** Chunks into units: the ones whose chunks changed are laid out again; the others stay as they are. */
  private regroup() {
    const groups: Part[][] = [];
    for (const c of [...this.parts.keys()].sort((a, b) => a - b)) {
      const p = this.parts.get(c)!;
      const last = groups[groups.length - 1];
      // Never three: a page depends on at most the chunk before it.
      if (p.joins && last?.length === 1 && last[0].c === c - 1) last.push(p);
      else groups.push([p]);
    }
    const old = new Map(this.units.map((u) => [u.parts[0].c, u]));
    const units: Unit[] = [];
    const changed = new Set<Unit>();
    for (const g of groups) {
      const partial = g[0].joins && !this.parts.has(g[0].c - 1);
      let u = old.get(g[0].c);
      if (u && u.partial === partial && u.parts.length === g.length && u.parts.every((p, k) => p === g[k])) {
        // As it was.
      } else if (u && !u.partial && !partial && u.parts.length === 1 && g.length === 2 && u.parts[0] === g[0]) {
        // The chunk after it came: it goes on on the last page, the pages before stay as they are.
        u.parts = g;
        this.append(u, g[1]);
        changed.add(u);
      } else {
        const el = document.createElement('section');
        el.className = 'chunk';
        u = { parts: g, el, partial, cols: 1, screens: 1, offset: 0, starts: [0] };
        this.fill(u);
        changed.add(u);
      }
      units.push(u);
    }
    for (const u of this.units) if (!units.includes(u)) u.el.remove();
    // On the strip in order; the ones already there stay where they are in it.
    let prev: Element | null = null;
    for (const u of units) {
      const want: Element | null = prev ? prev.nextElementSibling : this.strip.firstElementChild;
      if (u.el !== want) this.strip.insertBefore(u.el, want);
      prev = u.el;
    }
    for (const u of changed) this.measureUnit(u);
    this.units = units;
    this.layoutStrip();
    if (changed.size) drawMarks();
    // A unit laid out without the chunk before it: ask for that chunk now, before the reader gets there.
    const first = units[0];
    if (first?.partial) send({ t: 'need', chunks: [first.parts[0].c - 1] });
  }

  /** A unit's chunks in its element. */
  private fill(u: Unit) {
    u.el.dataset.c = String(u.parts[0].c);
    u.el.innerHTML = u.parts[0].html;
    for (const p of u.parts.slice(1)) this.append(u, p);
    this.watchImages(u.el);
  }

  /** The second chunk of a unit after the first: a paragraph cut between them is one paragraph again. */
  private append(u: Unit, p: Part) {
    const last = u.el.lastElementChild as HTMLElement | null;
    u.el.insertAdjacentHTML('beforeend', p.html);
    const next = (last ? last.nextElementSibling : u.el.firstElementChild) as HTMLElement | null;
    if (last && next) fuse(last, next);
    this.watchImages(u.el);
  }

  /**
   * What stays together on a page, from the unit as laid out (read first,
   * then marked: a mark between two reads would lay it out again each time).
   * A short paragraph (KEEP_LINES) stays whole: its lines are counted (keeping
   * it whole doesn't change them). A heading keeps room under it (base.css)
   * for what must go with it: the heading after it and that one's room, a
   * picture, an empty line and what follows it, or three lines of text. Never
   * more than fits on a page with it: a room split onto the next page would
   * pull the text after it up off that page.
   */
  private keepShort(root: HTMLElement) {
    const styles = new Map<Element, CSSStyleDeclaration>();
    const style = (el: Element) => {
      let st = styles.get(el);
      if (!st) styles.set(el, (st = getComputedStyle(el)));
      return st;
    };
    const px = (v: string) => parseFloat(v) || 0;
    const origin = root.getBoundingClientRect().left + this.frame.left - (this.frame.inset?.left ?? 0);
    const lines = (el: HTMLElement) => {
      const lh = px(style(el).lineHeight);
      if (!lh) return 0;
      const pieces = el.getClientRects();
      // In one piece: its height. Split between pages, its first piece reaches the page's foot: the lines its text is on.
      return pieces.length === 1 ? Math.round(pieces[0].height / lh) : this.linesOf(el, origin);
    };
    const keep: [HTMLElement, boolean][] = [];
    for (const el of root.querySelectorAll<HTMLElement>(':scope > .p, :scope > .q, :scope > .v')) {
      const n = lines(el);
      const short = n > 1 && n <= KEEP_LINES;
      if (short !== el.classList.contains('keep')) keep.push([el, short]);
    }
    // Headings, the last first: one keeps room for the heading after it and that one's room.
    const page = this.frame.height - 1;
    const body = getComputedStyle(document.documentElement);
    const line = px(body.getPropertyValue('--line'));
    const gap = px(body.getPropertyValue('--gap'));
    const heading = (el: Element | null): el is HTMLElement => !!el && /^h[1-6]$/.test(el.classList[0] ?? '');
    const height = (el: Element) => [...el.getClientRects()].reduce((n, q) => n + q.height, 0);
    const room = new Map<HTMLElement, number>();
    const textOf = (h: HTMLElement) => height(h) - px(getComputedStyle(h, '::after').height);
    /** The space what comes after `el` (whose bottom margin is `mb`) needs on its page. */
    const after = (next: Element | null, mb: number, depth = 0): number => {
      if (!next || depth > 3) return 0;
      const space = Math.max(mb, px(style(next).marginTop));
      if (heading(next)) return space + textOf(next) + (room.get(next) ?? 0);
      if (next.classList.contains('img')) return space + height(next);
      // An empty line or a rule, and what follows it.
      if (next.classList.contains('sp') || next.classList.contains('hr')) return space + height(next) + after(next.nextElementSibling, px(style(next).marginBottom), depth + 1);
      return space + Math.min(lines(next as HTMLElement), 3) * px(style(next).lineHeight);
    };
    const rooms: [HTMLElement, string][] = [];
    for (const h of [...root.querySelectorAll<HTMLElement>(':scope > .h1, :scope > .h2, :scope > .h3, :scope > .h4, :scope > .h5, :scope > .h6')].reverse()) {
      const text = textOf(h);
      const mb = px(style(h).marginBottom);
      let r = h.nextElementSibling ? after(h.nextElementSibling, mb) + 1 : 0;
      // Too much for a page: room for three lines, or (a heading that fills a page) none.
      if (text + r > page) r = Math.max(mb, gap) + 3 * line + 1;
      if (text + r > page) r = 0;
      room.set(h, r);
      const v = `${Math.round(r)}px`;
      if (h.style.getPropertyValue('--keep') !== v) rooms.push([h, v]);
    }
    for (const [el, short] of keep) el.classList.toggle('keep', short);
    for (const [h, v] of rooms) h.style.setProperty('--keep', v);
  }

  /** The lines a block's text is drawn on (superscripts aside), across pages. */
  private linesOf(el: HTMLElement, origin: number) {
    const { gap } = this.frame;
    const pitch = this.pitch;
    const seen = new Set<string>();
    const r = document.createRange();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement?.closest('.sup, .sub')) continue;
      r.selectNodeContents(n);
      for (const q of r.getClientRects()) if (q.width > 0) seen.add(`${Math.floor((q.left - origin + gap / 2) / pitch)}|${Math.round(q.bottom)}`);
    }
    return seen.size;
  }

  private watchImages(root: HTMLElement) {
    for (const img of root.querySelectorAll('img')) {
      if (this.watched.has(img)) continue;
      this.watched.add(img);
      img.addEventListener('load', () => this.relayoutSoon(), { once: true });
    }
  }

  /** How many columns a unit's text takes, laid out at one page's width, and where its chunks' pages start. */
  private measureUnit(u: Unit) {
    const pitch = this.pitch;
    u.el.style.left = '0px';
    this.keepShort(u.el);
    // Column n's text starts at origin + n pitches; columns meet half way across the gap between them.
    const left = u.el.getBoundingClientRect().left;
    const origin = left + this.frame.left - (this.frame.inset?.left ?? 0);
    const colOf = (x: number) => Math.max(0, Math.floor((x - origin + this.frame.gap / 2) / pitch));
    let lastLeft = origin;
    const last = u.el.lastElementChild;
    if (last) {
      const rects = [...last.getClientRects()];
      if (rects.length) lastLeft = Math.max(...rects.map((r) => r.left));
    }
    u.cols = colOf(lastLeft) + 1;
    u.screens = Math.ceil(u.cols / this.perScreen);
    u.starts = [0];
    for (const p of u.parts.slice(1)) {
      // The column its first character is in: the page is its own if that character starts the page.
      const el = u.el.querySelector<HTMLElement>(`[data-b="${p.first}"]`);
      if (!el) {
        u.starts.push(u.cols);
        continue;
      }
      const s = colOf(leftOf(el));
      const top = firstIn(blocksIn(u.el), left + s * pitch);
      u.starts.push(top && top.b >= p.first ? s : Math.min(s + 1, u.cols));
    }
  }

  private measure() {
    for (const u of this.units) this.measureUnit(u);
    this.layoutStrip();
  }

  private layoutStrip() {
    let offset = 0;
    for (const u of this.units) {
      u.offset = offset;
      u.el.style.left = `${offset * this.screenWidth}px`;
      offset += u.screens;
    }
  }

  private place(screen: number, animate = false) {
    this.screen = Math.max(0, Math.min(screen, Math.max(0, this.totalScreens() - 1)));
    this.strip.style.transition = animate ? `transform ${SLIDE_MS}ms ease-out` : 'none';
    this.strip.style.transform = `translate3d(${-this.screen * this.screenWidth}px,0,0)`;
  }

  /** A drag that took the page mid-slide: where it was then, from the screen shown, less the finger's way so far. */
  private dragFrom = 0;

  /**
   * Follow a finger dragging the page (`dx` points; held back where there's no
   * page to go to). A turn still sliding lands at once, but the page stays
   * where it is and the finger takes it from there: a quick reader's next
   * swipe never waits for the last one, and nothing jumps.
   */
  drag(dx: number) {
    let from: number | null = null;
    if (this.finish) {
      const now = getComputedStyle(this.strip).transform;
      from = now && now !== 'none' ? new DOMMatrixReadOnly(now).m41 : null;
      this.finish();
    }
    clearFlash();
    const can = this.open(this.screen + (dx < 0 ? 1 : -1));
    const way = can ? dx : dx * 0.25;
    if (from !== null) this.dragFrom = from + this.screen * this.screenWidth - way;
    this.strip.style.transition = 'none';
    this.strip.style.transform = `translate3d(${-this.screen * this.screenWidth + this.dragFrom + way}px,0,0)`;
  }

  springBack() {
    this.dragFrom = 0;
    this.strip.style.transition = `transform 180ms ease-out`;
    this.strip.style.transform = `translate3d(${-this.screen * this.screenWidth}px,0,0)`;
  }

  get followsFinger() {
    return this.setup?.turn === 'slide';
  }

  /** Lands the turn sliding at once (null: none). */
  private finish: (() => void) | null = null;

  private animateTo(to: number) {
    this.dragFrom = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const land = () => {
      clearTimeout(timer);
      this.finish = null;
      this.animating = false;
      try {
        this.place(to);
        this.report(true);
      } finally {
        // (Whatever happened, the messages waiting for it go on.)
        for (const r of this.landed.splice(0)) r();
      }
    };
    this.animating = true;
    if (this.setup.turn === 'slide') {
      this.place(to, true);
      timer = setTimeout(land, SLIDE_MS + 20);
      this.finish = land;
    } else if (this.setup.turn === 'fade') {
      this.viewport.style.transition = 'opacity 110ms';
      this.viewport.style.opacity = '0';
      const shown = () => {
        land();
        this.viewport.style.transition = 'opacity 140ms';
        this.viewport.style.opacity = '1';
      };
      timer = setTimeout(shown, 110);
      this.finish = shown;
    } else land();
  }

  /** A turn past the pages that can be shown: ask for the chunk it takes, or say the book ends here. */
  private edge(dir: 1 | -1) {
    this.springBack();
    let need: number | null;
    if (dir < 0) {
      const first = this.units[0]?.parts[0];
      need = this.wanted(this.screen - 1) ?? (first && first.c > 0 && this.screen === 0 ? first.c - 1 : null);
    } else {
      const last = this.units[this.units.length - 1]?.parts.at(-1);
      need = last && last.c + 1 < this.count ? last.c + 1 : null;
      if (need === null && last && this.complete) send({ t: 'end' });
    }
    if (need !== null) send({ t: 'need', chunks: [need] });
  }

  // ---- where things are ----

  private stripLeft() {
    return this.strip.getBoundingClientRect().left;
  }

  /** The screen a drawn point is on, along the strip; null if its block isn't on the strip. */
  private screenOf(p: DrawnPoint): number | null {
    const part = partAt(this.strip, p.b, p.i);
    if (!part) return null;
    const { el } = part;
    let box: DOMRect | null = null;
    const len = lengthOf(el);
    for (let i = Math.min(part.i, Math.max(0, len - 1)); !box && i < len; i++) box = charBox(el, i);
    if (!box) box = el.getClientRects()[0] ?? el.getBoundingClientRect();
    return Math.floor((box.left - this.stripLeft() + 1) / this.screenWidth);
  }

  /** The screen a target is on (null: not on the strip). */
  private screenFor(target: Target): number | null {
    if ('at' in target) return this.screenOf(target.at);
    const u = this.units.find((x) => x.parts.some((p) => p.c === target.chunk));
    if (!u) return null;
    const k = u.parts.findIndex((p) => p.c === target.chunk);
    const from = u.starts[k];
    const to = (u.starts[k + 1] ?? u.cols) - 1;
    let col: number;
    // A chunk without a page of its own (all of it on the page before's foot): that page.
    if (to < from) col = Math.max(0, Math.min(from, u.cols) - 1);
    else if ('page' in target) col = Math.min(from + target.page, to);
    else col = target.edge === 'first' ? from : to;
    return u.offset + Math.floor(col / this.perScreen);
  }

  private show(target: Target, turned: boolean) {
    const screen = this.screenFor(target);
    if (screen === null || !this.open(screen)) {
      // Not on the strip, or not laid out as it will be yet: shown once its chunk comes.
      this.waiting = target;
      const need = screen === null ? null : this.wanted(screen);
      if (need !== null) send({ t: 'need', chunks: [need] });
      return;
    }
    this.waiting = null;
    this.arrived = 'at' in target ? target.at : null;
    this.place(screen);
    this.report(turned);
    // Laid out anew (another size, font, mode...): pages are always cut the same way, so the
    // page holding the place needn't start with it. The line read, marked for a moment.
    if ('at' in target && target.top) flashLine(this.strip, target.at, this.viewport);
  }

  /** The first drawn point at or after strip x `x0`; null past the end. */
  private firstFrom(x0: number): DrawnPoint | null {
    return firstIn(blocksIn(this.strip), this.stripLeft() + x0);
  }

  /** The first character of the screen shown (null: nothing on the strip). */
  private shownPoint(): DrawnPoint | null {
    return this.units.length ? this.firstFrom(this.screen * this.screenWidth) : null;
  }

  /** Back on the screen showing `here`, after chunks came or went (the strip moved under it). */
  private keep(here: DrawnPoint | null) {
    const s = here ? this.screenOf(here) : null;
    this.place(s ?? this.screen);
  }

  /** Tell the screen what's shown. */
  report(turned: boolean) {
    const a = this.at(this.screen);
    if (!a) return;
    const w = this.screenWidth;
    const first = this.firstFrom(this.screen * w) ?? { b: a.part.first, i: 0 };
    const next = this.firstFrom((this.screen + 1) * w);
    if (turned || !this.arrived) this.arrived = first;
    const lastUnit = this.units[this.units.length - 1];
    const lastPage = this.complete && a.u === lastUnit && lastUnit.parts[lastUnit.parts.length - 1].c === this.count - 1 && this.screen === a.u.offset + a.u.screens - 1;
    send({ t: 'shown', first, next, chunk: a.part.c, turned, key: this.key, lastPage });
    const counts: { c: number; pages: number; chars: number }[] = [];
    for (const u of this.units) {
      if (u.partial) continue;
      u.parts.forEach((p, k) => {
        if (p.live) counts.push({ c: p.c, pages: (u.starts[k + 1] ?? u.cols) - u.starts[k], chars: p.chars });
      });
    }
    const span = this.perScreen === 2 && a.col + 1 < a.u.cols ? 2 : 1;
    send({ t: 'pages', counts, chunk: a.part.c, page: a.col - a.u.starts[a.k], span });
  }

  private relayoutTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Something changed size (an image loaded): lay out again, on the place
   * arrived at (what the screen shows now may already have moved).
   */
  relayoutSoon() {
    if (this.relayoutTimer) clearTimeout(this.relayoutTimer);
    this.relayoutTimer = setTimeout(() => {
      if (!this.at(this.screen)) return;
      const anchor = this.arrived ?? this.firstFrom(this.screen * this.screenWidth);
      this.measure();
      if (anchor) this.show({ at: anchor }, false);
    }, 50);
  }
}

/** Where an element's first character (or the element) is drawn, from the left. */
function leftOf(el: HTMLElement): number {
  const len = lengthOf(el);
  for (let i = 0; i < len; i++) {
    const box = charBox(el, i);
    if (box) return box.left;
  }
  return (el.getClientRects()[0] ?? el.getBoundingClientRect()).left;
}

/** The first drawn point at or after x `x0` (window coordinates) among `blocks` (in reading order, left to right); null past the end. */
function firstIn(blocks: HTMLElement[], x0: number): DrawnPoint | null {
  // The first block that reaches x0.
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const rs = blocks[mid].getClientRects();
    const right = rs.length ? Math.max(...[...rs].map((r) => r.right)) : -Infinity;
    if (right <= x0 + 1) lo = mid + 1;
    else hi = mid;
  }
  for (let k = lo; k < blocks.length; k++) {
    const el = blocks[k];
    const b = Number(el.dataset.b);
    const len = lengthOf(el);
    if (!len) {
      const r = el.getClientRects()[0];
      if (r && r.left >= x0 - 1) return { b, i: 0 };
      continue;
    }
    // The first character drawn at or after x0.
    const at = (i: number) => {
      for (let j = i; j < len; j++) {
        const box = charBox(el, j);
        if (box) return box.left;
      }
      return Infinity;
    };
    if (at(len - 1) < x0 - 1) continue;
    let a = 0;
    let z = len - 1;
    while (a < z) {
      const m = (a + z) >> 1;
      if (at(m) >= x0 - 1) z = m;
      else a = m + 1;
    }
    return { b, i: a };
  }
  return null;
}

/**
 * The rest of a paragraph (html.ts: a wrapper of continuation blocks) put
 * back onto its start, the last block of the chunk before.
 */
function fuse(a: HTMLElement, b: HTMLElement) {
  if (!b.hasAttribute('data-w') || !b.classList.contains('c') || a.classList[0] !== b.classList[0]) return;
  let w = a;
  if (!a.hasAttribute('data-w')) {
    if (a.dataset.b === undefined) return;
    // A paragraph of one block: made a wrapper of one part.
    w = document.createElement('div');
    w.setAttribute('data-w', '');
    w.className = a.className;
    const part = document.createElement('p');
    part.dataset.b = a.dataset.b;
    part.append(...a.childNodes);
    w.appendChild(part);
    a.replaceWith(w);
  }
  w.append(...b.childNodes);
  b.remove();
}

/** A unit's second chunk taken out of it: its blocks from block `first` on. */
function removeFrom(root: HTMLElement, first: number) {
  for (const el of [...root.querySelectorAll<HTMLElement>('[data-b]')]) if (Number(el.dataset.b) >= first) el.remove();
  for (const w of [...root.querySelectorAll('[data-w]')]) if (!w.querySelector('[data-b]')) w.remove();
}
