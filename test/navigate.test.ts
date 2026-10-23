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
    expect(chapterTarget(toc, { b: 3, o: 0 }, 1)).toBe(10);
    expect(chapterTarget(toc, { b: 10, o: 0 }, 1)).toBe(20);
    expect(chapterTarget(toc, { b: 25, o: 0 }, 1)).toBeNull();
  });

  it('previous chapter: the start of this one first, then the one before', () => {
    expect(chapterTarget(toc, { b: 15, o: 0 }, -1)).toBe(10);
    expect(chapterTarget(toc, { b: 10, o: 0 }, -1)).toBe(0);
    // Further into the chapter's first paragraph: back to its start, not the chapter before.
    expect(chapterTarget(toc, { b: 10, o: 500 }, -1)).toBe(10);
    expect(chapterTarget(toc, { b: 0, o: 0 }, -1)).toBeNull();
    expect(chapterTarget([], { b: 5, o: 0 }, -1)).toBeNull();
  });

  it('a page number or a percentage', () => {
    expect(parseGoTo('1', 200)).toBe(0.0025); // the middle of page 1
    expect(parseGoTo(' 101 ', 200)).toBe(0.5025);
    expect(parseGoTo('45%', 200)).toBe(0.45);
    expect(parseGoTo('12,5%', 200)).toBe(0.125);
    // No page numbers (scroll mode): a plain number is a percentage.
    expect(parseGoTo('45', null)).toBe(0.45);
    for (const bad of ['', 'abc', '0', '201', '2.5', '150%', '-3']) expect(parseGoTo(bad, 200)).toBeNull();
  });
});
