/// <reference types="jest" />
// Stands in for the reader page inside the WebView (src/reader/web/page),
// speaking the same messages the way it does: it keeps the chunks it's sent,
// cuts them into pages (PAGE_CHARS drawn characters each, or what `pageSize`
// says for a chunk: chunks hold different amounts of text a page), each chunk
// starting a page of its own unless it goes on from the one before
// (Chunk.joins: then a page belongs to the chunk of its first character),
// turns pages (two at a time in a two-page spread), keeps showing the same
// text when chunks before it are dropped, and answers a moment later (each
// message after the ones before it), never during the call that sent it. The
// real page is tested in real browser engines (bench/webpage).

import type { Chunk, DrawnPoint, FromPage, PageMark, Target, ToPage } from '@/reader/web/protocol';

export const PAGE_CHARS = 400;

interface Block {
  b: number;
  len: number;
  text: string;
}

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** The blocks of a chunk's HTML: each element with data-b, and its text. */
export function parseChunk(html: string): Block[] {
  const out: Block[] = [];
  const re = /<(p|h[1-6]|div) data-b="(\d+)"[^>]*>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const text = decode(m[3].replace(/<[^>]*>/g, ''));
    out.push({ b: Number(m[2]), len: text.length, text });
  }
  return out;
}

interface Page {
  c: number;
  first: DrawnPoint;
}

export class FakePage {
  /** Every message the screen sent. */
  sent: ToPage[] = [];
  chunks = new Map<number, Block[]>();
  /** Chunks that go on from the one before on its last page (Chunk.joins). */
  private joins = new Set<number>();
  marks: PageMark[] = [];
  /** The highlight tool's drag as it goes (drawn over the marks). */
  stroke: PageMark[] = [];
  marking = false;
  /** The key of the layout and content the page has now (echoed in 'shown', as the page does). */
  key = '';
  mode: 'page' | 'scroll' = 'page';
  /** Two pages side by side (a wide screen in landscape). */
  spread = false;
  /** Drawn characters a page of chunk `c` holds, for pages made from now on (see FakePage.pageSize). */
  pageSize: (c: number) => number = (c) => FakePage.pageSize(c);
  /** What every page made from now on holds, per chunk: PAGE_CHARS unless a test says otherwise. */
  static pageSize: (c: number) => number = () => PAGE_CHARS;
  private count = 0;
  private complete = false;
  /** The page shown (the left one in a spread), counted along all pages held. */
  private at = 0;
  private waiting: Target | null = null;
  /** Messages are answered one after another, a moment after they arrive. */
  private queue: Promise<void> = Promise.resolve();
  constructor(private reply: (m: FromPage) => void) {}

  /** The setup key: what the page was last set up with. */
  get setupKey() {
    return this.key;
  }

  /** The page loaded (again, after a reload: with nothing in it). */
  load() {
    this.chunks = new Map();
    this.key = '';
    this.at = 0;
    this.waiting = null;
    this.reply({ t: 'ready' });
  }

  /** Something happened on the page (a tap, a selection, a highlighter stroke...). */
  emit(m: FromPage) {
    this.reply(m);
  }

  receive(m: ToPage) {
    this.sent.push(m);
    this.queue = this.queue.then(() => this.handle(m)).catch((e) => console.error('fake page:', e));
  }

  /** The page busy (laying out, say): nothing sent from now on is answered until the function returned is called. */
  hold(): () => void {
    let go!: () => void;
    const held = new Promise<void>((r) => (go = r));
    this.queue = this.queue.then(() => held);
    return go;
  }

  private handle(m: ToPage) {
    switch (m.t) {
      case 'setup':
        this.key = m.key;
        // A new mode starts with an empty page, as the real one does.
        if (m.setup.mode !== this.mode) {
          this.chunks = new Map();
          this.at = 0;
        }
        this.mode = m.setup.mode;
        this.spread = m.setup.frame.spread;
        if (this.chunks.size) this.show(m.target, false);
        else this.waiting = m.target;
        return;
      case 'content':
        this.key = m.key;
        this.chunks = new Map();
        this.add(m.chunks);
        this.waiting = null;
        return this.show(m.target, false);
      case 'add': {
        const before = this.shown();
        this.add(m.chunks);
        // Still on the same page (chunks added before it push it along).
        if (before) this.at = this.indexOf(before);
        if (this.waiting) {
          const t = this.waiting;
          this.waiting = null;
          return this.show(t, false);
        }
        // The real page in page mode tells what's shown after an add (scroll mode doesn't).
        if (this.mode === 'page') this.report(false);
        return;
      }
      case 'drop': {
        const before = this.shown();
        for (const c of m.chunks) this.chunks.delete(c);
        if (before && this.chunks.has(before.c)) this.at = this.indexOf(before);
        else this.at = Math.min(this.at, Math.max(0, this.pages().length - 1));
        return;
      }
      case 'bounds':
        this.count = m.count;
        this.complete = m.complete;
        return;
      case 'go':
        return this.show(m.target, false);
      case 'turn':
        // Scroll mode doesn't turn pages.
        if (this.mode === 'page') this.turn(m.dir);
        return;
      case 'marks':
        this.marks = m.marks;
        return;
      case 'stroke':
        this.stroke = m.marks;
        return;
      case 'tool':
        this.marking = m.marking;
        return;
      case 'measure':
        // As the real page: only in the layout it has, each chunk laid out on its own, out of sight.
        if (m.key !== this.key || this.mode !== 'page') return;
        return this.reply({ t: 'measured', key: m.key, counts: m.chunks.map((ch) => ({ c: ch.c, pages: this.pagesOf(ch.c, parseChunk(ch.html)).length })) });
    }
  }

  /** Every message sent so far has been answered. */
  settled(): Promise<void> {
    return this.queue;
  }

  private add(cs: Chunk[]) {
    for (const ch of cs) {
      this.chunks.set(ch.c, parseChunk(ch.html));
      if (ch.joins) this.joins.add(ch.c);
      else this.joins.delete(ch.c);
    }
  }

  /** All pages of the chunks held, in order. */
  pages(): Page[] {
    const out: Page[] = [];
    let prev = -2;
    let used = 0;
    for (const c of [...this.chunks.keys()].sort((a, b) => a - b)) {
      const size = this.pageSize(c);
      // A chunk going on from the one before fills that one's last page; any other starts a page of its own.
      if (!(this.joins.has(c) && prev === c - 1)) used = size;
      for (const blk of this.chunks.get(c)!) {
        let i = 0;
        do {
          if (used >= size) {
            out.push({ c, first: { b: blk.b, i } });
            used = 0;
          }
          const take = Math.min(blk.len - i, size - used);
          used += Math.max(1, take);
          i += take;
        } while (i < blk.len);
      }
      prev = c;
    }
    return out;
  }

  /** The pages of chunk `c` laid out on its own (as for 'measure'), starting on a page of its own. */
  private pagesOf(c: number, blocks: Block[]): Page[] {
    const out: Page[] = [];
    const size = this.pageSize(c);
    let used = size;
    for (const blk of blocks) {
      let i = 0;
      do {
        if (used >= size) {
          out.push({ c, first: { b: blk.b, i } });
          used = 0;
        }
        const take = Math.min(blk.len - i, size - used);
        used += Math.max(1, take);
        i += take;
      } while (i < blk.len);
    }
    return out;
  }

  private get perScreen() {
    return this.mode === 'page' && this.spread ? 2 : 1;
  }

  /** The page index of `p` (by its place) among the pages held now. */
  private indexOf(p: Page): number {
    const k = this.pages().findIndex((x) => x.c === p.c && x.first.b === p.first.b && x.first.i === p.first.i);
    return Math.max(0, k);
  }

  /** The first page of the screen holding page `k` (in a spread, screens start at each chunk's even pages). */
  private screenStart(k: number): number {
    if (this.perScreen === 1) return k;
    const ps = this.pages();
    const first = ps.findIndex((p) => p.c === ps[k]?.c);
    return first + Math.floor((k - first) / 2) * 2;
  }

  private find(t: Target): number {
    const ps = this.pages();
    if ('at' in t) {
      let k = -1;
      ps.forEach((p, n) => {
        if (p.first.b < t.at.b || (p.first.b === t.at.b && p.first.i <= t.at.i)) k = n;
      });
      return k;
    }
    const inChunk = ps.map((p, n) => [p, n] as const).filter(([p]) => p.c === t.chunk);
    if (!inChunk.length) return -1;
    if ('page' in t) return inChunk[Math.min(t.page, inChunk.length - 1)][1];
    return t.edge === 'first' ? inChunk[0][1] : inChunk[inChunk.length - 1][1];
  }

  private show(t: Target, turned: boolean) {
    const k = this.find(t);
    // Not on the strip: shown when its chunk comes.
    if (k < 0 || ('at' in t && this.text(t.at.b) === undefined)) {
      this.waiting = t;
      return;
    }
    this.waiting = null;
    this.at = this.screenStart(k);
    this.report(turned);
  }

  /** The page shown now (the left one in a spread). */
  shown(): Page {
    return this.pages()[this.at];
  }

  turn(dir: 1 | -1) {
    const ps = this.pages();
    const cur = ps[this.at];
    let to: number;
    if (dir > 0) {
      // The next screen: past the pages this one shows (both in a spread, of this chunk).
      to = this.at + 1;
      if (this.perScreen === 2 && ps[to]?.c === cur?.c) to++;
    } else to = this.at - 1 >= 0 ? this.screenStart(this.at - 1) : -1;
    if (to < 0) {
      const first = ps[0];
      if (first && first.c > 0) this.reply({ t: 'need', chunks: [first.c - 1] });
      return;
    }
    if (to >= ps.length) {
      const last = ps[ps.length - 1];
      if (last && last.c + 1 < this.count) this.reply({ t: 'need', chunks: [last.c + 1] });
      else if (this.complete) this.reply({ t: 'end' });
      return;
    }
    this.at = to;
    this.report(true);
  }

  /** Scroll mode: the reader scrolled to block `b`. */
  scrollTo(b: number) {
    const k = this.find({ at: { b, i: 0 } });
    if (k < 0) return;
    this.at = k;
    this.report(true);
  }

  private report(turned: boolean) {
    const ps = this.pages();
    const p = ps[this.at];
    if (!p) return;
    const showing = this.perScreen === 2 && ps[this.at + 1]?.c === p.c ? 2 : 1;
    const next = ps[this.at + showing];
    const lastC = Math.max(...this.chunks.keys());
    const lastPage = this.complete && p.c === lastC && lastC === this.count - 1 && !next;
    // Page numbers (page mode only), in the same message.
    const counts = [...this.chunks.keys()].map((c) => ({ c, pages: ps.filter((x) => x.c === c).length, chars: this.chunks.get(c)!.reduce((n, b) => n + b.len, 0) }));
    const pages = this.mode === 'page' ? { counts, chunk: p.c, page: ps.filter((x) => x.c === p.c).indexOf(p), span: showing as 1 | 2 } : undefined;
    this.reply({ t: 'shown', first: p.first, next: next?.first ?? null, chunk: p.c, turned, key: this.key, lastPage, pages });
  }

  /** The last message of a kind the screen sent. */
  last<T extends ToPage['t']>(t: T): Extract<ToPage, { t: T }> | undefined {
    return [...this.sent].reverse().find((m) => m.t === t) as Extract<ToPage, { t: T }> | undefined;
  }

  /** The drawn text of a block the page holds. */
  text(b: number): string | undefined {
    for (const blocks of this.chunks.values()) for (const blk of blocks) if (blk.b === b) return blk.text;
    return undefined;
  }
}
