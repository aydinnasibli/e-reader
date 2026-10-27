// Scroll mode: the chunks around the place read, one under the other, in a
// page the WebView scrolls itself. Chunks are added above and below as the
// reader nears them, and dropped far away, keeping the text on screen still.

import type { Chunk, DrawnPoint, PageSetup, Target } from '../protocol';
import { send } from './bridge';
import { draw as drawMarks } from './marks';
import { clearFlash, flashLine } from './flash';
import { blockOf, blocksIn, charBox, lengthOf } from './text';

interface Section {
  c: number;
  el: HTMLElement;
}

/** Ask for the next chunk this many screens before reaching it. */
const AHEAD = 2;

export class Scrolled {
  private flow: HTMLElement;
  private end: HTMLElement;
  private sections: Section[] = [];
  private setup!: PageSetup;
  private key = '';
  private count = 0;
  private complete = false;
  private asked = new Set<number>();
  private waiting: Target | null = null;
  private autoSpeed = 0;
  private autoAt = 0;
  private autoFrom = 0;
  /** Auto-scroll: the text is drawn this much higher than the page is scrolled (see autoStep). */
  private higher = 0;
  private reachedEnd = false;
  /** What was last told: the place reported changes paragraph by paragraph, and at most twice a second within one. */
  private told = { b: -1, at: 0 };
  /**
   * The first block on screen, where it was and the scroll position then: kept
   * there when something above changes size. Taken again only when the page
   * has scrolled, not when text moved under a still page.
   */
  private held: { el: HTMLElement; top: number; y: number } | null = null;
  /** Chunks changing size (a picture loading): keep the text on screen still. */
  private resized = new ResizeObserver(() => this.keepHeld());
  /**
   * Where the page last scrolled itself to (a jump, keeping the text still as
   * chunks come and go or pictures load): the reader at that place hasn't
   * read on (`shown` is told with turned false). Auto-scroll is reading on.
   */
  private placed: number | null = null;

  constructor(private root: HTMLElement) {
    this.flow = document.createElement('div');
    this.flow.id = 'flow';
    this.end = document.createElement('div');
    this.end.className = 'end';
    root.appendChild(this.flow);
    root.appendChild(this.end);
    window.addEventListener('scroll', this.scrolled, { passive: true });
  }

  private pending = false;
  private scrolled = () => {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.onScroll();
    });
  };

  /** The view is done with (the mode changed): it no longer hears the window scroll, nor watches sizes. */
  dispose() {
    window.removeEventListener('scroll', this.scrolled);
    this.resized.disconnect();
    this.autoSpeed = 0;
  }

  configure(setup: PageSetup, key: string, target: Target) {
    const same = !!this.setup && key === this.key && JSON.stringify(this.setup.frame) === JSON.stringify(setup.frame);
    this.setup = setup;
    this.key = key;
    this.updateEnd();
    // Only the colours (or the like) changed: the text stays where it is.
    if (!same) this.show(target);
  }

  setContent(chunks: Chunk[], target: Target, key: string) {
    this.key = key;
    this.waiting = null;
    clearFlash();
    this.resized.disconnect();
    this.held = null;
    this.flow.textContent = '';
    this.sections = [];
    this.asked.clear();
    this.reachedEnd = false;
    this.insert(chunks);
    this.show(target);
  }

  add(chunks: Chunk[]) {
    this.insert(chunks);
    if (this.waiting) {
      const t = this.waiting;
      this.waiting = null;
      this.show(t);
    }
  }

  drop(cs: number[]) {
    for (const s of this.sections.filter((x) => cs.includes(x.c))) {
      const above = s.el.getBoundingClientRect().bottom <= 0;
      const h = s.el.offsetHeight;
      this.resized.unobserve(s.el);
      s.el.remove();
      if (above) this.shift(-h);
    }
    this.sections = this.sections.filter((x) => !cs.includes(x.c));
    for (const c of cs) this.asked.delete(c);
  }

  bounds(count: number, complete: boolean) {
    this.count = count;
    this.complete = complete;
    // The line at the end goes when the chunk after comes, not before: the page would get
    // shorter under a reader at its foot and scroll back.
    this.updateEnd(true);
  }

  go(target: Target) {
    this.show(target);
  }

  /** Auto-scroll at `speed` points a second; 0 stops. */
  auto(speed: number) {
    const was = this.autoSpeed;
    this.autoSpeed = speed;
    if (speed > 0 && !was) {
      this.autoAt = performance.now();
      this.autoFrom = window.scrollY;
      this.flow.style.willChange = 'transform';
      requestAnimationFrame((t) => this.autoStep(t));
    } else if (speed <= 0 && was) this.stopAuto();
  }

  /** Auto-scroll over: the part of a point the text was drawn higher by (see autoStep) made a scroll. */
  private stopAuto() {
    const frac = this.higher;
    this.drawHigher(0);
    this.flow.style.willChange = '';
    if (frac >= 0.5) {
      window.scrollBy(0, 1);
      this.placed = window.scrollY;
    }
  }

  /** The text drawn `dy` points higher than the page is scrolled (less than a point). */
  private drawHigher(dy: number) {
    if (dy === this.higher) return;
    this.higher = dy;
    this.flow.style.transform = dy ? `translate3d(0,${(-dy).toFixed(3)}px,0)` : '';
  }

  /** The page scrolled by `dy` under the reader (chunks added or dropped above): auto-scroll goes on from there. */
  private shift(dy: number) {
    window.scrollBy(0, dy);
    this.autoFrom += dy;
    this.placed = window.scrollY;
  }

  /** The reader touched the page while it was scrolling by itself. */
  touched() {
    if (this.autoSpeed > 0) send({ t: 'autoInterrupt' });
  }

  private autoStep(now: number) {
    if (this.autoSpeed <= 0 || !this.flow.isConnected) return;
    const y = this.autoFrom + ((now - this.autoAt) / 1000) * this.autoSpeed;
    // A page scrolls by whole points only: at reading speed (a fraction of a point a frame) the
    // text would stand still and jump. The rest of a point it's drawn higher by instead.
    const whole = Math.floor(y);
    window.scrollTo(0, whole);
    this.drawHigher(window.scrollY === whole ? y - whole : 0);
    // Stuck at the bottom with nothing more to come: auto-scroll is over.
    if (window.scrollY < whole - 2 && this.atBookEnd()) {
      this.autoSpeed = 0;
      this.stopAuto();
      send({ t: 'autoEnd' });
      return;
    }
    // At the bottom of what's there, waiting for the next chunk (or moved under it): it goes on from
    // where the page is, not from where it would have got to meanwhile.
    if (window.scrollY < whole - 1 || Math.abs(window.scrollY - y) > 200) {
      this.autoFrom = window.scrollY;
      this.autoAt = now;
    }
    requestAnimationFrame((t) => this.autoStep(t));
  }

  private atBookEnd() {
    const last = this.sections[this.sections.length - 1];
    return this.complete && !!last && last.c === this.count - 1;
  }

  /** The line after the last chunk here: the book's end, or that the rest is being prepared. `keep`: not taken away now. */
  private updateEnd(keep = false) {
    if (!this.setup) return;
    const lastShown = this.sections[this.sections.length - 1];
    const atEnd = !!lastShown && lastShown.c === this.count - 1;
    if (!atEnd && keep) return;
    this.end.textContent = atEnd ? (this.complete ? this.setup.theEnd : this.setup.processing) : '';
    this.end.style.display = atEnd ? 'block' : 'none';
  }

  private insert(chunks: Chunk[]) {
    for (const ch of chunks) {
      if (this.sections.some((s) => s.c === ch.c)) continue;
      const el = document.createElement('section');
      el.className = 'chunk';
      el.dataset.c = String(ch.c);
      el.innerHTML = ch.html;
      this.resized.observe(el);
      const s = { c: ch.c, el };
      const at = this.sections.findIndex((x) => x.c > ch.c);
      if (at < 0) {
        this.sections.push(s);
        this.flow.appendChild(el);
      } else {
        // Above what's on screen: keep the text on screen where it is.
        const before = document.documentElement.scrollHeight;
        this.flow.insertBefore(el, this.sections[at].el);
        this.sections.splice(at, 0, s);
        this.shift(document.documentElement.scrollHeight - before);
      }
    }
    this.updateEnd();
    drawMarks();
  }

  private show(target: Target) {
    let y: number | null = null;
    if ('at' in target) {
      const el = this.flow.querySelector<HTMLElement>(`[data-b="${target.at.b}"]`);
      if (el) {
        const len = lengthOf(el);
        let box: DOMRect | null = null;
        for (let i = Math.min(target.at.i, Math.max(0, len - 1)); !box && i < len; i++) box = charBox(el, i);
        y = (box ?? el.getBoundingClientRect()).top + window.scrollY;
      }
    } else {
      const s = this.sections.find((x) => x.c === target.chunk);
      if (s) y = 'page' in target || target.edge === 'first' ? s.el.getBoundingClientRect().top + window.scrollY : s.el.getBoundingClientRect().bottom + window.scrollY - window.innerHeight;
    }
    if (y === null) {
      this.waiting = target;
      return;
    }
    this.waiting = null;
    window.scrollTo(0, Math.max(0, y - this.setup.frame.top));
    this.placed = window.scrollY;
    this.autoFrom = window.scrollY;
    this.autoAt = performance.now();
    this.onScroll(true);
    // Laid out anew (another mode, size, font...): the line read, marked for a moment.
    if ('at' in target && target.top) flashLine(this.flow, target.at, this.root);
  }

  /** Something changed size: the text on screen stays where it was. */
  private keepHeld() {
    const h = this.held;
    if (!h || !h.el.isConnected) return;
    const moved = h.el.getBoundingClientRect().top - h.top;
    if (Math.abs(moved) > 0.5) this.shift(moved);
    h.y = window.scrollY;
  }

  /**
   * The first text at the top of the screen: the first character of the line
   * there, or below it where the top falls between paragraphs. (Where it's
   * asked for a point, the browser can give the end of the paragraph above.)
   */
  private firstShown(): DrawnPoint | null {
    const top = this.setup.frame.top + 0.5;
    const blocks = blocksIn(this.flow);
    // The first block reaching below the top: blocks run down the page.
    let lo = 0;
    let hi = blocks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].getBoundingClientRect().bottom <= top) lo = mid + 1;
      else hi = mid;
    }
    for (const el of blocks.slice(lo)) {
      const b = Number(el.dataset.b);
      const len = lengthOf(el);
      // Its first character drawn below the top (lines run down too). Its box can reach below the
      // top with none of its letters (the space under a line): then it's the next block's first.
      const bottom = (i: number) => {
        for (let j = i; j < len; j++) {
          const box = charBox(el, j);
          if (box) return box.bottom;
        }
        return -Infinity;
      };
      if (!len) return { b, i: 0 };
      if (bottom(len - 1) <= top) continue;
      let a = 0;
      let z = len - 1;
      while (a < z) {
        const m = (a + z) >> 1;
        if (bottom(m) > top) z = m;
        else a = m + 1;
      }
      return { b, i: a };
    }
    return null;
  }

  private onScroll(jumped = false) {
    // (A view left behind by a change of mode hears the window's scrolling too.)
    if (!this.setup || !this.flow.isConnected) return;
    // Text that moved under a still page (a picture above loaded) is put back first.
    if (this.held && Math.abs(window.scrollY - this.held.y) <= 0.5) this.keepHeld();
    const first = this.firstShown();
    const s = first ? blockOf(this.flow.querySelector(`[data-b="${first.b}"]`)) : null;
    if (!this.held || !this.held.el.isConnected || Math.abs(window.scrollY - this.held.y) > 0.5) this.held = s ? { el: s, top: s.getBoundingClientRect().top, y: window.scrollY } : null;
    const chunk = Number(s?.closest('section')?.getAttribute('data-c') ?? this.sections[0]?.c ?? 0);
    const now = performance.now();
    // Moved by the reader (or auto-scroll), or by the page itself (see placed; WebKit can settle a point off).
    const read = !jumped && (this.placed === null || Math.abs(window.scrollY - this.placed) > 2);
    if (read) this.placed = null;
    if (first && (jumped || first.b !== this.told.b || now - this.told.at > 500)) {
      this.told = { b: first.b, at: now };
      send({ t: 'shown', first, next: null, chunk, turned: read, key: this.key, lastPage: false });
    }
    // Ask for chunks before they're needed.
    const h = window.innerHeight;
    const doc = document.documentElement;
    const want: number[] = [];
    const firstS = this.sections[0];
    const lastS = this.sections[this.sections.length - 1];
    if (lastS && doc.scrollHeight - (window.scrollY + h) < h * AHEAD && lastS.c + 1 < this.count) want.push(lastS.c + 1);
    if (firstS && window.scrollY < h * AHEAD && firstS.c > 0) want.push(firstS.c - 1);
    const fresh = want.filter((c) => !this.asked.has(c));
    for (const c of fresh) this.asked.add(c);
    if (fresh.length) send({ t: 'need', chunks: fresh });
    // The end of the book in view.
    if (this.atBookEnd() && window.scrollY + h >= doc.scrollHeight - 40) {
      if (!this.reachedEnd) send({ t: 'reachEnd' });
      this.reachedEnd = true;
    } else this.reachedEnd = false;
  }
}
