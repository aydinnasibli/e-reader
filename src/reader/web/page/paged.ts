// Page mode. Each chunk is a section laid out in CSS columns one page apart
// (two to a screen in a spread); sections sit side by side on a strip that
// slides one screen per page turn. Only the chunks around the place read are
// on the strip, so page 30,000 of a 100 MB book costs what page 3 does.

import type { Chunk, DrawnPoint, PageFrame, PageSetup, Target } from '../protocol';
import { send } from './bridge';
import { draw as drawMarks } from './marks';
import { blocksIn, charBox, lengthOf } from './text';

interface Section {
  c: number;
  el: HTMLElement;
  chars: number;
  /** Text columns (pages) and screens it takes. */
  cols: number;
  screens: number;
  /** Screens before it on the strip. */
  offset: number;
}

const SLIDE_MS = 220;

export class Paged {
  private strip: HTMLElement;
  private sections: Section[] = [];
  /** The screen shown, counted along the strip. */
  private screen = 0;
  private frame!: PageFrame;
  private setup!: PageSetup;
  private key = '';
  private count = 0;
  private complete = false;
  private animating = false;
  /** A place asked for that isn't on the strip yet. */
  private waiting: Target | null = null;
  /** The place arrived at (opened, jumped to, turned to): kept when the page lays itself out again. */
  private arrived: DrawnPoint | null = null;

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

  get perScreen() {
    return this.frame.spread ? 2 : 1;
  }

  configure(setup: PageSetup, key: string, target: Target) {
    this.setup = setup;
    this.frame = setup.frame;
    this.key = key;
    this.measure();
    this.show(target, false);
  }

  setContent(chunks: Chunk[], target: Target, key: string) {
    this.key = key;
    this.strip.textContent = '';
    this.sections = [];
    this.insert(chunks);
    this.show(target, false);
  }

  add(chunks: Chunk[]) {
    const before = this.screen - (this.sections[0]?.offset ?? 0);
    const firstC = this.sections[0]?.c;
    this.insert(chunks);
    // Chunks added before the one shown push it along the strip: stay on it.
    if (firstC !== undefined) {
      const shift = this.sections.filter((s) => s.c < firstC).reduce((n, s) => n + s.screens, 0);
      this.place(before + shift);
    }
    if (this.waiting) {
      const t = this.waiting;
      this.waiting = null;
      this.show(t, false);
    } else this.report(false);
  }

  drop(cs: number[]) {
    const gone = this.sections.filter((s) => cs.includes(s.c));
    if (!gone.length) return;
    const shownC = this.sectionAt(this.screen)?.c;
    const shift = gone.filter((s) => shownC !== undefined && s.c < shownC).reduce((n, s) => n + s.screens, 0);
    for (const s of gone) s.el.remove();
    this.sections = this.sections.filter((s) => !cs.includes(s.c));
    this.layoutStrip();
    this.place(this.screen - shift);
  }

  bounds(count: number, complete: boolean) {
    this.count = count;
    this.complete = complete;
  }

  go(target: Target) {
    this.show(target, false);
  }

  /** A page turn (a tap, a swipe, auto page turn). */
  turn(dir: 1 | -1) {
    if (this.animating) return;
    const to = this.screen + dir;
    if (to < 0 || to >= this.totalScreens()) return this.edge(dir);
    this.animateTo(to);
  }

  // ---- the strip ----

  private totalScreens() {
    const last = this.sections[this.sections.length - 1];
    return last ? last.offset + last.screens : 0;
  }

  private sectionAt(screen: number): Section | undefined {
    return this.sections.find((s) => screen >= s.offset && screen < s.offset + s.screens);
  }

  private insert(chunks: Chunk[]) {
    for (const ch of chunks) {
      if (this.sections.some((s) => s.c === ch.c)) continue;
      const el = document.createElement('section');
      el.className = 'chunk';
      el.dataset.c = String(ch.c);
      el.innerHTML = ch.html;
      for (const img of el.querySelectorAll('img')) img.addEventListener('load', () => this.relayoutSoon(), { once: true });
      const s: Section = { c: ch.c, el, chars: ch.chars, cols: 1, screens: 1, offset: 0 };
      const at = this.sections.findIndex((x) => x.c > ch.c);
      if (at < 0) {
        this.sections.push(s);
        this.strip.appendChild(el);
      } else {
        this.strip.insertBefore(el, this.sections[at].el);
        this.sections.splice(at, 0, s);
      }
      this.measureSection(s);
    }
    this.layoutStrip();
    drawMarks();
  }

  /** How many columns a section's text takes, laid out at one page's width. */
  private measureSection(s: Section) {
    const { left, width, spread } = this.frame;
    const pitch = spread ? width / 2 : width;
    s.el.style.left = '0px';
    const origin = s.el.getBoundingClientRect().left;
    let lastLeft = origin + left;
    const last = s.el.lastElementChild;
    if (last) {
      const rects = [...last.getClientRects()];
      if (rects.length) lastLeft = Math.max(...rects.map((r) => r.left));
    }
    s.cols = Math.max(1, Math.floor((lastLeft - origin - left + pitch / 2) / pitch) + 1);
    s.screens = Math.ceil(s.cols / (spread ? 2 : 1));
  }

  private measure() {
    for (const s of this.sections) this.measureSection(s);
    this.layoutStrip();
  }

  private layoutStrip() {
    let offset = 0;
    for (const s of this.sections) {
      s.offset = offset;
      s.el.style.left = `${offset * this.frame.width}px`;
      offset += s.screens;
    }
  }

  private place(screen: number, animate = false) {
    this.screen = Math.max(0, Math.min(screen, Math.max(0, this.totalScreens() - 1)));
    this.strip.style.transition = animate ? `transform ${SLIDE_MS}ms ease-out` : 'none';
    this.strip.style.transform = `translate3d(${-this.screen * this.frame.width}px,0,0)`;
  }

  /** Follow a finger dragging the page (`dx` points; held back where there's no page to go to). */
  drag(dx: number) {
    if (this.animating) return;
    const dir = dx < 0 ? 1 : -1;
    const can = this.screen + dir >= 0 && this.screen + dir < this.totalScreens();
    this.strip.style.transition = 'none';
    this.strip.style.transform = `translate3d(${-this.screen * this.frame.width + (can ? dx : dx * 0.25)}px,0,0)`;
  }

  springBack() {
    this.strip.style.transition = `transform 180ms ease-out`;
    this.strip.style.transform = `translate3d(${-this.screen * this.frame.width}px,0,0)`;
  }

  get followsFinger() {
    return this.setup?.turn === 'slide';
  }

  private animateTo(to: number) {
    const land = () => {
      this.animating = false;
      this.place(to);
      this.report(true);
    };
    this.animating = true;
    if (this.setup.turn === 'slide') {
      this.place(to, true);
      setTimeout(land, SLIDE_MS + 20);
    } else if (this.setup.turn === 'fade') {
      this.viewport.style.transition = 'opacity 110ms';
      this.viewport.style.opacity = '0';
      setTimeout(() => {
        land();
        this.viewport.style.transition = 'opacity 140ms';
        this.viewport.style.opacity = '1';
      }, 110);
    } else land();
  }

  /** A turn past the pages on the strip: ask for the next chunk, or say the book ends here. */
  private edge(dir: 1 | -1) {
    this.springBack();
    const first = this.sections[0];
    const last = this.sections[this.sections.length - 1];
    if (!first || !last) return;
    if (dir < 0 && first.c > 0) send({ t: 'need', chunks: [first.c - 1] });
    if (dir > 0) {
      if (last.c + 1 < this.count) send({ t: 'need', chunks: [last.c + 1] });
      else if (this.complete) send({ t: 'end' });
    }
  }

  // ---- where things are ----

  private stripLeft() {
    return this.strip.getBoundingClientRect().left;
  }

  /** The block element of `b`, if it's on the strip. */
  private block(b: number): HTMLElement | null {
    return this.strip.querySelector<HTMLElement>(`[data-b="${b}"]`);
  }

  /** The screen a drawn point is on, along the strip; null if its block isn't on the strip. */
  private screenOf(p: DrawnPoint): number | null {
    const el = this.block(p.b);
    if (!el) return null;
    let box: DOMRect | null = null;
    const len = lengthOf(el);
    for (let i = Math.min(p.i, Math.max(0, len - 1)); !box && i < len; i++) box = charBox(el, i);
    if (!box) box = el.getClientRects()[0] ?? el.getBoundingClientRect();
    return Math.floor((box.left - this.stripLeft() + 1) / this.frame.width);
  }

  private show(target: Target, turned: boolean) {
    let screen: number | null = null;
    if ('at' in target) screen = this.screenOf(target.at);
    else {
      const s = this.sections.find((x) => x.c === target.chunk);
      if (s) screen = target.edge === 'first' ? s.offset : s.offset + s.screens - 1;
    }
    if (screen === null) {
      // Not on the strip: the screen sends it.
      this.waiting = target;
      return;
    }
    this.arrived = 'at' in target ? target.at : null;
    this.place(screen);
    this.report(turned);
  }

  /** The first drawn point at or after strip x `x0`, scanning blocks in reading order; null past the end. */
  private firstFrom(x0: number): DrawnPoint | null {
    const left = this.stripLeft();
    const xOf = (r: DOMRect) => r.left - left;
    const blocks = blocksIn(this.strip);
    // The first block that reaches x0 (blocks run left to right along the strip).
    let lo = 0;
    let hi = blocks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const rs = blocks[mid].getClientRects();
      const right = rs.length ? Math.max(...[...rs].map((r) => r.right - left)) : -Infinity;
      if (right <= x0 + 1) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < blocks.length; k++) {
      const el = blocks[k];
      const b = Number(el.dataset.b);
      const len = lengthOf(el);
      if (!len) {
        const r = el.getClientRects()[0];
        if (r && xOf(r) >= x0 - 1) return { b, i: 0 };
        continue;
      }
      // The first character drawn at or after x0.
      const at = (i: number) => {
        for (let j = i; j < len; j++) {
          const box = charBox(el, j);
          if (box) return xOf(box);
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

  /** Tell the screen what's shown. */
  report(turned: boolean) {
    const s = this.sectionAt(this.screen);
    if (!s) return;
    const w = this.frame.width;
    const first = this.firstFrom(this.screen * w) ?? { b: Number(blocksIn(s.el)[0]?.dataset.b ?? 0), i: 0 };
    const next = this.firstFrom((this.screen + 1) * w);
    if (turned || !this.arrived) this.arrived = first;
    const lastSection = this.sections[this.sections.length - 1];
    const lastPage = this.complete && s === lastSection && s.c === this.count - 1 && this.screen === s.offset + s.screens - 1;
    send({ t: 'shown', first, next, chunk: s.c, turned, key: this.key, lastPage });
    send({
      t: 'pages',
      counts: this.sections.map((x) => ({ c: x.c, pages: x.cols, chars: x.chars })),
      chunk: s.c,
      page: (this.screen - s.offset) * this.perScreen,
    });
  }

  private relayoutTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Something changed size (an image loaded): lay out again, on the place
   * arrived at (what the screen shows now may already have moved).
   */
  relayoutSoon() {
    if (this.relayoutTimer) clearTimeout(this.relayoutTimer);
    this.relayoutTimer = setTimeout(() => {
      if (!this.sectionAt(this.screen)) return;
      const anchor = this.arrived ?? this.firstFrom(this.screen * this.frame.width);
      this.measure();
      if (anchor) this.show({ at: anchor }, false);
    }, 50);
  }
}
