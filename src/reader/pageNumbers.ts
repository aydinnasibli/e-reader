// Page numbers for books far too big to paginate whole. Every chunk has a
// weight: how much page space it takes, worked out by the converter (its
// characters, for books converted before weights existed). One measurement
// per layout, the weight a page holds, taken from the first chunks laid out
// and then kept for good, fixes how many pages every chunk is given: page N
// always means the same place, whatever is laid out at the moment. Inside a
// chunk pages count up one by one; a chunk that turns out to have more pages
// than it was given repeats its last number, one with fewer skips the rest.
// Pure, so it's tested.

/** A chunk laid out: its weight and the pages it took. */
export interface Sample {
  weight: number;
  pages: number;
}

/**
 * The weight a full page holds in a layout, from chunks laid out in it: the
 * median over those with enough in them to tell (not a cover, a title page
 * or a stub of a chapter), or null when none has. `typical` is the weight of
 * a typical chunk of the book.
 *
 * Every chunk starts on a page of its own, so its last page is part empty:
 * half, on average. A chunk of `pages` pages holds about `pages - 0.5` pages
 * of text.
 */
export function measure(samples: Sample[], typical: number): number | null {
  const per = samples
    .filter((s) => s.pages >= 2 && s.weight > 0 && s.weight >= typical / 2)
    .map((s) => s.weight / (s.pages - 0.5))
    .sort((a, b) => a - b);
  if (!per.length) return null;
  const mid = (per.length - 1) / 2;
  return (per[Math.floor(mid)] + per[Math.ceil(mid)]) / 2;
}

/** The weight a page holds when no chunk is big enough to measure: whatever the chunks laid out say. */
export function roughMeasure(samples: Sample[]): number | null {
  let weight = 0;
  let pages = 0;
  for (const s of samples) {
    if (s.pages > 0 && s.weight > 0) {
      weight += s.weight;
      pages += s.pages;
    }
  }
  return pages ? weight / pages : null;
}

/** The median of the chunk weights: what a typical chunk weighs (the last, usually short, left out). */
export function typicalWeight(weights: number[]): number {
  const w = (weights.length > 2 ? weights.slice(0, -1) : weights).slice().sort((a, b) => a - b);
  return w.length ? w[Math.floor(w.length / 2)] : 0;
}

/**
 * Chunks to measure a layout on, out of sight: chunks like most of the book
 * (not its first or last, not much smaller than a typical chunk, and with as
 * much weight per character as most, so not mostly a contents list or
 * pictures), spread through it. The weight a page holds is the same for
 * these at every text size; on the chunks around a book's start (a cover, a
 * long contents list) it can be a fifth off at the smallest and largest
 * sizes, and every chunk's last numbers then repeat or are skipped. Empty for
 * a book too small to have any: then the chunks laid out are all there is.
 */
export function typicalChunks(weights: number[], chars: number[], max = 3): number[] {
  const n = weights.length;
  if (n < 4) return [];
  const typical = typicalWeight(weights);
  const density = (c: number) => weights[c] / chars[c];
  const middle: number[] = [];
  for (let c = 1; c < n - 1; c++) if (chars[c] > 0 && weights[c] >= typical * 0.75) middle.push(c);
  if (!middle.length) return [];
  const sorted = middle.map(density).sort((a, b) => a - b);
  const usual = sorted[Math.floor(sorted.length / 2)];
  const like = middle.filter((c) => Math.abs(density(c) / usual - 1) <= 0.15);
  // The ones nearest a quarter, half and three quarters of the way through.
  const picks: number[] = [];
  for (let k = 1; k <= max; k++) {
    const want = (n * k) / (max + 1);
    let best = -1;
    for (const c of like) if (!picks.includes(c) && (best < 0 || Math.abs(c - want) < Math.abs(best - want))) best = c;
    if (best >= 0) picks.push(best);
  }
  return picks.sort((a, b) => a - b);
}

/** Where a page is: its chunk, and its index among the chunk's pages; `last`: the book's last page. */
export interface PagePlace {
  c: number;
  index: number;
  last?: boolean;
}

/** Rounding up, forgiving the last bit of a sum of fractions (3.0000000001 pages are 3). */
const up = (x: number) => Math.ceil(x - 1e-9);

export class PageNumbers {
  /** Where each chunk starts and ends, in pages from the start of the book (fractions: inside a page). */
  private starts: number[] = [];
  private ends: number[] = [];
  /** The last page number there is, or an estimate while the book is still being converted. */
  readonly total: number;
  /** The last page number that exists now (the end of what's converted). */
  readonly ready: number;

  /**
   * `weights`: one per chunk converted so far. `perPage`: the weight a page
   * holds (see measure). `estimatedWeight`: the whole book's weight, an
   * estimate while it's still being converted. `joins(c)`: chunk c goes on
   * from the one before on its last page (Chunk.joins) instead of starting a
   * page of its own, as every other chunk does.
   */
  constructor(
    weights: number[],
    readonly perPage: number,
    readonly complete: boolean,
    estimatedWeight = 0,
    joins: (c: number) => boolean = () => false,
  ) {
    let end = 0;
    let known = 0;
    weights.forEach((w, c) => {
      const start = c > 0 && joins(c) ? end : up(end);
      end = start + w / perPage;
      this.starts.push(start);
      this.ends.push(end);
      known += w;
    });
    this.ready = Math.max(1, up(end));
    this.total = complete || known <= 0 || estimatedWeight <= known ? this.ready : Math.max(this.ready, Math.round((this.ready * estimatedWeight) / known));
  }

  get chunks() {
    return this.starts.length;
  }

  /** Number of the first page that starts in chunk `c` (a page belongs to the chunk of its first character). */
  first(c: number): number {
    return c < this.chunks ? up(this.starts[c]) + 1 : this.ready + 1;
  }

  /** How many pages start in chunk `c` (none, for a short chunk that goes on from the one before on its last page). */
  share(c: number): number {
    return c < this.chunks ? Math.max(0, up(this.ends[c]) - up(this.starts[c])) : 0;
  }

  /** The number of page `index` of chunk `c` (counted among the pages starting in it), laid out to `pages` pages. */
  number(c: number, index: number, pages: number): number {
    // The book's last page has the last number, whatever the pages before it got.
    if (this.complete && c === this.chunks - 1 && index >= pages - 1) return this.total;
    return this.first(c) + Math.max(0, Math.min(index, this.share(c) - 1));
  }

  /** Where page `n` is; null if that part of the book isn't converted yet. */
  find(n: number): PagePlace | null {
    if (!this.chunks) return null;
    const last = this.chunks - 1;
    if (n > this.ready) return this.complete ? { c: last, index: Math.max(0, this.share(last) - 1), last: true } : null;
    if (this.complete && n === this.total) return { c: last, index: Math.max(0, n - this.first(last)), last: true };
    // The last chunk starting at or before page n that has pages of its own.
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.first(mid) <= n) lo = mid;
      else hi = mid - 1;
    }
    while (lo > 0 && this.share(lo) === 0) lo--;
    return { c: lo, index: Math.max(0, n - this.first(lo)) };
  }

  /**
   * The page a place `f` (0..1) of the way through chunk `c` is on, as near
   * as can be told without laying the chunk out.
   */
  at(c: number, f: number): number {
    if (c >= this.chunks) return this.total;
    const pos = this.starts[c] + Math.max(0, Math.min(1, f)) * (this.ends[c] - this.starts[c]);
    const n = Math.floor(pos + 1e-9) + 1;
    return Math.max(1, Math.min(n, this.share(c) > 0 ? this.first(c) + this.share(c) - 1 : n, this.total));
  }
}

/**
 * The page at `f` (0..1) along the book, for the slider: the page shown at
 * `here`, the first and last at the ends, pages spread evenly in between. So
 * the slider shows the page you're on, and dragging it starts from there.
 */
export function pageAtFraction(f: number, here: number, page: number, total: number): number {
  const n = f <= here ? (here > 0 ? 1 + ((page - 1) * f) / here : 1) : here < 1 ? page + ((total - page) * (f - here)) / (1 - here) : total;
  return Math.min(total, Math.max(1, Math.round(n)));
}
