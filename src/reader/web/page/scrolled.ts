// Scroll mode: the chunks around the place read, one under the other, in a
// page the WebView scrolls itself. Chunks are added above and below as the
// reader nears them, and dropped far away, keeping the text on screen still.

import type { Chunk, DrawnPoint, PageSetup, Target } from '../protocol';
import { send } from './bridge';
import { draw as drawMarks } from './marks';
import { blockOf, blocksIn, charBox, lengthOf, pointAtScreen } from './text';

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
  private reachedEnd = false;
  /** What was last told: the place reported changes paragraph by paragraph, and at most twice a second within one. */
  private told = { b: -1, at: 0 };

  constructor(root: HTMLElement) {
    this.flow = document.createElement('div');
    this.flow.id = 'flow';
    this.end = document.createElement('div');
    this.end.className = 'end';
    root.appendChild(this.flow);
    root.appendChild(this.end);
    let pending = false;
    window.addEventListener(
      'scroll',
      () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          this.onScroll();
        });
      },
      { passive: true },
    );
  }

  configure(setup: PageSetup, key: string, target: Target) {
    this.setup = setup;
    this.key = key;
    this.updateEnd();
    this.show(target);
  }

  setContent(chunks: Chunk[], target: Target, key: string) {
    this.key = key;
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
      s.el.remove();
      if (above) window.scrollBy(0, -h);
    }
    this.sections = this.sections.filter((x) => !cs.includes(x.c));
    for (const c of cs) this.asked.delete(c);
  }

  bounds(count: number, complete: boolean) {
    this.count = count;
    this.complete = complete;
    this.updateEnd();
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
      requestAnimationFrame((t) => this.autoStep(t));
    }
  }

  /** The reader touched the page while it was scrolling by itself. */
  touched() {
    if (this.autoSpeed > 0) send({ t: 'autoInterrupt' });
  }

  private autoStep(now: number) {
    if (this.autoSpeed <= 0) return;
    const y = this.autoFrom + ((now - this.autoAt) / 1000) * this.autoSpeed;
    window.scrollTo(0, y);
    // Stuck at the bottom with nothing more to come: auto-scroll is over.
    if (window.scrollY < y - 2 && this.atBookEnd()) {
      this.autoSpeed = 0;
      send({ t: 'autoEnd' });
      return;
    }
    // Moved under it (chunks dropped above): carry on from where the page is.
    if (Math.abs(window.scrollY - y) > 200) {
      this.autoFrom = window.scrollY;
      this.autoAt = now;
    }
    requestAnimationFrame((t) => this.autoStep(t));
  }

  private atBookEnd() {
    const last = this.sections[this.sections.length - 1];
    return this.complete && !!last && last.c === this.count - 1;
  }

  private updateEnd() {
    if (!this.setup) return;
    const lastShown = this.sections[this.sections.length - 1];
    const atEnd = !!lastShown && lastShown.c === this.count - 1;
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
        window.scrollBy(0, document.documentElement.scrollHeight - before);
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
      if (s) y = target.edge === 'first' ? s.el.getBoundingClientRect().top + window.scrollY : s.el.getBoundingClientRect().bottom + window.scrollY - window.innerHeight;
    }
    if (y === null) {
      this.waiting = target;
      return;
    }
    window.scrollTo(0, Math.max(0, y - this.setup.frame.top));
    this.autoFrom = window.scrollY;
    this.autoAt = performance.now();
    this.onScroll(true);
  }

  /** The first text at the top of the screen. */
  private firstShown(): DrawnPoint | null {
    const { left, top } = this.setup.frame;
    const p = pointAtScreen(left + 2, top + 2);
    if (p) return p;
    // Between paragraphs: the first block reaching below the top.
    for (const el of blocksIn(this.flow)) if (el.getBoundingClientRect().bottom > top) return { b: Number(el.dataset.b), i: 0 };
    return null;
  }

  private onScroll(jumped = false) {
    if (!this.setup) return;
    const first = this.firstShown();
    const s = first ? blockOf(this.flow.querySelector(`[data-b="${first.b}"]`)) : null;
    const chunk = Number(s?.closest('section')?.getAttribute('data-c') ?? this.sections[0]?.c ?? 0);
    const now = performance.now();
    if (first && (jumped || first.b !== this.told.b || now - this.told.at > 500)) {
      this.told = { b: first.b, at: now };
      send({ t: 'shown', first, next: null, chunk, turned: !jumped, key: this.key, lastPage: false });
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
