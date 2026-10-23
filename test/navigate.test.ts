import { describe, expect, it } from 'vitest';
import { chapterTarget, parseGoTo } from '../src/reader/navigate';

describe('moving around a book', () => {
  // Chapters start at blocks 0, 10, 20; a part heading shares block 10 with its first chapter.
  const toc = [
    { t: 'One', l: 0, b: 0 },
    { t: 'Part II', l: 0, b: 10 },
    { t: 'Two', l: 1, b: 10 },
    { t: 'Three', l: 1, b: 20 },
  ];

  it('next chapter', () => {
    expect(chapterTarget(toc, 3, 1)).toBe(10);
    expect(chapterTarget(toc, 10, 1)).toBe(20);
    expect(chapterTarget(toc, 25, 1)).toBeNull();
  });

  it('previous chapter: the start of this one first, then the one before', () => {
    expect(chapterTarget(toc, 15, -1)).toBe(10);
    expect(chapterTarget(toc, 10, -1)).toBe(0);
    expect(chapterTarget(toc, 0, -1)).toBeNull();
    expect(chapterTarget([], 5, -1)).toBeNull();
  });

  it('a page number or a percentage', () => {
    expect(parseGoTo('1', 200)).toBe(0);
    expect(parseGoTo(' 101 ', 200)).toBe(0.5);
    expect(parseGoTo('45%', 200)).toBe(0.45);
    expect(parseGoTo('12,5%', 200)).toBe(0.125);
    // No page numbers (scroll mode): a plain number is a percentage.
    expect(parseGoTo('45', null)).toBe(0.45);
    for (const bad of ['', 'abc', '0', '201', '2.5', '150%', '-3']) expect(parseGoTo(bad, 200)).toBeNull();
  });
});
