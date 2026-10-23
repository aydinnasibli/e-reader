import { describe, expect, it } from 'vitest';
import { charsPerPage, pageCount, pageNumber, pagesBetween } from '../src/reader/pageNumbers';

describe('page numbers', () => {
  it('chars per page comes from the laid-out chunks', () => {
    expect(charsPerPage([])).toBeNull();
    expect(charsPerPage([{ chars: 30_000, pages: 20 }, { chars: 30_000, pages: 20 }])).toBe(1500);
    expect(charsPerPage([{ chars: 30_000, pages: 20 }, { chars: 0, pages: 0 }])).toBe(1500);
  });

  it('pages count up one by one inside a chunk', () => {
    // 30,000 characters on 20 pages, at 1500 a page.
    expect(pageNumber(0, 30_000, 0, 1500)).toBe(1);
    expect(pageNumber(0, 30_000, 1, 1500)).toBe(2);
    expect(pageNumber(0, 30_000, 19, 1500)).toBe(20);
    // The next chunk starts 30,000 characters in: page 21.
    expect(pageNumber(30_000, 30_000, 0, 1500)).toBe(21);
  });

  it('never go backwards from one chunk into the next', () => {
    // Three 50,000-character chunks laid out to 80, 120 and 80 pages: the middle one has more pages than its share.
    const cpp = charsPerPage([{ chars: 50_000, pages: 80 }, { chars: 50_000, pages: 120 }, { chars: 50_000, pages: 80 }])!;
    const sizes = [80, 120, 80];
    let prev = 0;
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < sizes[c]; i++) {
        const n = pageNumber(c * 50_000, 50_000, i, cpp);
        // One by one wherever the chunk has room for its pages.
        if (i > 0 && c !== 1) expect(n).toBe(prev + 1);
        expect(n).toBeGreaterThanOrEqual(prev);
        prev = n;
      }
    }
    expect(prev).toBeLessThanOrEqual(pageCount(150_000, cpp));
  });

  it('total pages and pages left', () => {
    expect(pageCount(1_245_000, 1500)).toBe(830);
    expect(pageCount(10, 1500)).toBe(1);
    expect(pagesBetween(10_000, 28_000, 1500)).toBe(12);
    expect(pagesBetween(28_000, 10_000, 1500)).toBe(0);
  });
});
