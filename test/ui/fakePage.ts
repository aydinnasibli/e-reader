/// <reference types="jest" />
// Stands in for the reader page inside the WebView (src/reader/web/page),
// speaking the same messages: it keeps the chunks it's sent, cuts them into
// pages of PAGE_CHARS drawn characters, turns pages and answers like the real
// page. The real page is tested in real browser engines (bench/webpage).

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
  marks: PageMark[] = [];
  marking = false;
  setupKey = '';
  mode: 'page' | 'scroll' = 'page';
  private count = 0;
  private complete = false;
  private at = 0;
  constructor(private reply: (m: FromPage) => void) {}

  /** The page loaded. */
  load() {
    this.reply({ t: 'ready' });
  }

  /** Something happened on the page (a tap, a selection, a highlighter stroke...). */
  emit(m: FromPage) {
    this.reply(m);
  }

  receive(m: ToPage) {
    this.sent.push(m);
    switch (m.t) {
      case 'setup':
        this.setupKey = m.key;
        this.mode = m.setup.mode;
        if (this.chunks.size) this.show(m.target, false);
        return;
      case 'content':
        this.chunks = new Map();
        this.add(m.chunks);
        return this.show(m.target, false);
      case 'add':
        return this.add(m.chunks);
      case 'drop':
        for (const c of m.chunks) this.chunks.delete(c);
        return;
      case 'bounds':
        this.count = m.count;
        this.complete = m.complete;
        return;
      case 'go':
        return this.show(m.target, false);
      case 'turn':
        return this.turn(m.dir);
      case 'marks':
        this.marks = m.marks;
        return;
      case 'tool':
        this.marking = m.marking;
        return;
    }
  }

  private add(cs: Chunk[]) {
    for (const ch of cs) this.chunks.set(ch.c, parseChunk(ch.html));
  }

  /** All pages of the chunks held, in order. */
  pages(): Page[] {
    const out: Page[] = [];
    for (const c of [...this.chunks.keys()].sort((a, b) => a - b)) {
      let used = PAGE_CHARS;
      for (const blk of this.chunks.get(c)!) {
        let i = 0;
        do {
          if (used >= PAGE_CHARS) {
            out.push({ c, first: { b: blk.b, i } });
            used = 0;
          }
          const take = Math.min(blk.len - i, PAGE_CHARS - used);
          used += Math.max(1, take);
          i += take;
        } while (i < blk.len);
      }
    }
    return out;
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
    return t.edge === 'first' ? inChunk[0][1] : inChunk[inChunk.length - 1][1];
  }

  private show(t: Target, turned: boolean) {
    const k = this.find(t);
    if (k < 0) return;
    this.at = k;
    this.report(turned);
  }

  /** The page shown now. */
  shown(): Page {
    return this.pages()[this.at];
  }

  turn(dir: 1 | -1) {
    const ps = this.pages();
    const to = this.at + dir;
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

  private report(turned: boolean) {
    const ps = this.pages();
    const p = ps[this.at];
    if (!p) return;
    const next = ps[this.at + 1];
    const lastC = Math.max(...this.chunks.keys());
    const lastPage = this.complete && p.c === lastC && lastC === this.count - 1 && !next;
    this.reply({ t: 'shown', first: p.first, next: next?.first ?? null, chunk: p.c, turned, key: this.setupKey, lastPage });
    const counts = [...this.chunks.keys()].map((c) => ({ c, pages: ps.filter((x) => x.c === c).length, chars: this.chunks.get(c)!.reduce((n, b) => n + b.len, 0) }));
    this.reply({ t: 'pages', counts, chunk: p.c, page: ps.filter((x) => x.c === p.c).indexOf(p) });
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
