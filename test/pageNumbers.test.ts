import { describe, expect, it } from 'vitest';
import { charsPerPage, pageCount, pageNumber, pagesBetween } from '../src/reader/pageNumbers';

describe('page numbers', () => {
  it('chars per page comes from the laid-out chunks', () => {
    expect(charsPerPage([])).toBeNull();
    expect(charsPerPage([{ chars: 30_000, pages: 20 }, { chars: 30_000, pages: 20 }])).toBe(1500);
    expect(charsPerPage([{ chars: 30_000, pages: 20 }, { chars: 0, pages: 0 }])).toBe(1500);
  });

  it('pages count up one by one inside a chunk', () => {
    expect(pageNumber(0, 0, 1500)).toBe(1);
    expect(pageNumber(0, 19, 1500)).toBe(20);
    // The next chunk starts 30,000 characters in: page 21.
    expect(pageNumber(30_000, 0, 1500)).toBe(21);
  });

  it('total pages and pages left', () => {
    expect(pageCount(1_245_000, 1500)).toBe(830);
    expect(pageCount(10, 1500)).toBe(1);
    expect(pagesBetween(10_000, 28_000, 1500)).toBe(12);
    expect(pagesBetween(28_000, 10_000, 1500)).toBe(0);
  });
});
