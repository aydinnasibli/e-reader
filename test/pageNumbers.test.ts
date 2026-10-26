import { describe, expect, it } from 'vitest';
import { PageNumbers, measure, pageAtFraction, roughMeasure, typicalChunks, typicalWeight } from '../src/reader/pageNumbers';

/** Repeatable pseudo-random numbers in [0, 1). */
function random(seed: number) {
  return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
}

/**
 * A book of chapters of many lengths (a chunk each, long ones split in
 * pieces), and the pages each chunk really takes when laid out: every chunk
 * starts on a new page, and pages hold `spread` more or less from chunk to
 * chunk (dialogue, headings, pictures).
 */
function book(seed: number, { chapters = 120, perPage = 20, spread = 0.05 } = {}) {
  const r = random(seed);
  const weights: number[] = [];
  for (let k = 0; k < chapters; k++) {
    let left = Math.round(perPage * (1 + r() * 14));
    while (left > 0) {
      const take = Math.min(left, perPage * 12);
      weights.push(take);
      left -= take;
    }
  }
  const pages = weights.map((w) => Math.max(1, Math.ceil(w / (perPage * (1 + (r() * 2 - 1) * spread)))));
  return { weights, pages };
}

describe('measuring a layout', () => {
  it('takes the median over chunks with enough in them, leaving out covers and stubs', () => {
    // 380 lines on 20 pages, 400 on 21, and a cover of 12 lines on one page.
    const per = measure(
      [
        { weight: 380, pages: 20 },
        { weight: 12, pages: 1 },
        { weight: 400, pages: 21 },
      ],
      390,
    )!;
    expect(per).toBeCloseTo((380 / 19.5 + 400 / 20.5) / 2);
    expect(measure([{ weight: 12, pages: 1 }], 390)).toBeNull();
    // A chunk far smaller than most (a short preface) says little about a full page.
    expect(measure([{ weight: 60, pages: 3 }], 390)).toBeNull();
    expect(roughMeasure([{ weight: 60, pages: 3 }])).toBe(20);
  });

  it('a typical chunk: the median, without the short last one', () => {
    expect(typicalWeight([300, 10, 400, 350, 5])).toBe(350);
    expect(typicalWeight([])).toBe(0);
  });

  it('chunks to measure on: like most of the book and spread through it, not the first or last, a small one, or one of short lines or pictures', () => {
    // 20 chunks of 30,000 characters weighing 900 lines each, but for a
    // contents list (0: short lines weigh more a character), a chunk of
    // pictures (9) and a small one (13).
    const chars = Array(20).fill(30000);
    const weights = Array(20).fill(900);
    weights[0] = 2000;
    weights[9] = 1500;
    chars[13] = 8000;
    weights[13] = 240;
    expect(typicalChunks(weights, chars)).toEqual([5, 10, 15]);
    // A book of a few chunks has none: the chunks laid out are all there is.
    expect(typicalChunks([900, 900, 300], [30000, 30000, 10000])).toEqual([]);
  });
});

describe('page numbers', () => {
  it('chunks get the pages their weight fills; pages count up one by one inside a chunk', () => {
    // 20 lines a page: 390 lines take 20 pages, 400 take 20, 10 take 1.
    const n = new PageNumbers([390, 400, 10], 20, true);
    expect([n.first(0), n.first(1), n.first(2)]).toEqual([1, 21, 41]);
    expect(n.total).toBe(41);
    expect(n.number(0, 0, 20)).toBe(1);
    expect(n.number(0, 19, 20)).toBe(20);
    expect(n.number(1, 0, 20)).toBe(21);
    // More pages than its share: the last number repeats. Fewer: the rest are skipped.
    expect(n.number(0, 20, 21)).toBe(20);
    expect(n.number(1, 18, 19)).toBe(39);
  });

  it("the book's last page has the last number, and going to it lands there", () => {
    const n = new PageNumbers([390, 400, 100], 20, true);
    expect(n.total).toBe(45);
    // The last chunk came out a page short: its last page is still 45.
    expect(n.number(2, 3, 4)).toBe(45);
    expect(n.number(2, 2, 4)).toBe(43);
    expect(n.find(45)).toEqual({ c: 2, index: 4, last: true });
    expect(n.find(99)).toMatchObject({ c: 2, last: true });
  });

  it('go to page N lands on page N wherever it exists; reading on, numbers never go back; the total never changes', () => {
    const shares: number[] = [];
    for (const seed of [1, 7, 42, 99, 123, 555]) {
      const { weights, pages } = book(seed);
      // Measured where the book was opened, from the chunks around it.
      for (const open of [0, Math.floor(weights.length / 3), Math.floor(weights.length / 2)]) {
        const strip = [open - 1, open, open + 1].filter((c) => c >= 0 && c < weights.length);
        const per = measure(
          strip.map((c) => ({ weight: weights[c], pages: pages[c] })),
          typicalWeight(weights),
        )!;
        const n = new PageNumbers(weights, per, true);
        let exact = 0;
        let worst = 0;
        for (let want = 1; want <= n.total; want++) {
          const at = n.find(want)!;
          const index = at.last ? pages[at.c] - 1 : Math.min(at.index, pages[at.c] - 1);
          const got = n.number(at.c, index, pages[at.c]);
          if (got === want) exact++;
          worst = Math.max(worst, Math.abs(got - want));
        }
        // A page that doesn't exist (a number skipped at the end of a chunk) is the only miss, by a page or two.
        shares.push(exact / n.total);
        expect(exact / n.total).toBeGreaterThan(0.93);
        expect(worst).toBeLessThanOrEqual(3);
        let prev = 0;
        for (let c = 0; c < weights.length; c++) {
          for (let i = 0; i < pages[c]; i++) {
            const got = n.number(c, i, pages[c]);
            expect(got).toBeGreaterThanOrEqual(prev);
            prev = got;
          }
        }
        expect(prev).toBe(n.total);
      }
    }
    expect(shares.reduce((a, b) => a + b) / shares.length).toBeGreaterThan(0.97);
  });

  it('a chapter cut in two for size goes on on the same page: pages belong to the chunk they start in', () => {
    // 310 lines and 290 more of one chapter: 30 pages in all, the 16th shared.
    const joined = new PageNumbers([310, 290, 100], 20, true, 0, (c) => c === 1);
    expect([joined.first(0), joined.share(0), joined.first(1), joined.share(1), joined.first(2)]).toEqual([1, 16, 17, 14, 31]);
    expect(joined.total).toBe(35);
    expect(joined.find(17)).toEqual({ c: 1, index: 0 });
    // Apart, the first chunk's last page would be part empty: a page more.
    expect(new PageNumbers([310, 290, 100], 20, true).first(2)).toBe(32);
    // A place early in the second chunk is on the page they share.
    expect(joined.at(1, 0)).toBe(16);
  });

  it('a short chunk going on from the one before can have no page of its own', () => {
    const n = new PageNumbers([310, 5, 200], 20, true, 0, (c) => c === 1);
    expect(n.share(1)).toBe(0);
    expect(n.find(16)).toEqual({ c: 0, index: 15 });
    expect(n.find(17)).toEqual({ c: 2, index: 0 });
    expect(n.at(1, 0.5)).toBe(16);
  });

  it('while converting: the total is an estimate, and pages not converted yet are not found', () => {
    // Two chunks of an estimated ten converted.
    const n = new PageNumbers([400, 400], 20, false, 4000);
    expect(n.ready).toBe(40);
    expect(n.total).toBe(200);
    expect(n.find(40)).toEqual({ c: 1, index: 19 });
    expect(n.find(41)).toBeNull();
    // Numbers of what's converted don't depend on the estimate.
    expect(new PageNumbers([400, 400, 400], 20, false, 5000).find(40)).toEqual({ c: 1, index: 19 });
  });

  it('a place inside a chunk, before it is laid out: its share of the chunk', () => {
    const n = new PageNumbers([400, 400], 20, true);
    expect(n.at(1, 0)).toBe(21);
    expect(n.at(1, 0.5)).toBe(31);
    expect(n.at(1, 1)).toBe(40);
  });

  it('the slider shows the page you are on, and the first and last at its ends', () => {
    // Page 23 of 5698 at 0.3% (the front pages hold less text than most).
    expect(pageAtFraction(0.003, 0.003, 23, 5698)).toBe(23);
    expect(pageAtFraction(0.0031, 0.003, 23, 5698)).toBe(24);
    expect(pageAtFraction(0.0015, 0.003, 23, 5698)).toBe(12);
    expect(pageAtFraction(0, 0.003, 23, 5698)).toBe(1);
    expect(pageAtFraction(1, 0.003, 23, 5698)).toBe(5698);
    expect(pageAtFraction(0.5, 0, 1, 100)).toBe(51);
    expect(pageAtFraction(0.5, 1, 100, 100)).toBe(51);
  });
});
