// What the reader screen says about the place read: time left in the chapter
// and the book, the page the progress slider stands for, pages left in the
// chapter, and the back chip's label. Worked out from the book and the page
// numbers the reader reported; pure.

import type { Position } from '@/engine/types';
import { formatMinutes } from '@/ui/format';
import type { BookData } from './book';
import { chapterTarget } from './navigate';
import { pageAtFraction } from './pageNumbers';
import type { Back } from './useReadingPlace';
import type { PageInfo } from './web/WebReader';

/** `speed`: this reader's characters a minute. */
export function readerInfo(book: BookData, pos: Position, pageInfo: PageInfo | null, back: Back | null, speed: number) {
  // Time left, from this reader's measured speed.
  const here = book.charOffset(pos);
  const prevChapter = chapterTarget(book.toc, pos, -1);
  const nextChapter = chapterTarget(book.toc, pos, 1);
  const chapterLeft = nextChapter !== null ? (book.charOffset({ b: nextChapter, o: 0 }) - here) / speed : null;
  const bookLeft = (book.estimatedChars - here) / speed;
  const footerRight = chapterLeft !== null && chapterLeft > 0 ? `${formatMinutes(chapterLeft)} left in chapter` : `${formatMinutes(bookLeft)} left`;
  const fraction = book.fraction(pos);
  const numbers = pageInfo?.numbers;
  /** The page a place is on, in the layout's numbering (exact at a chunk's start, estimated inside it). */
  const pageOfPlace = (p: Position) => numbers!.at(book.chunkOf(p.b), book.fractionInChunk(p));
  /** Pages from page `n` to the start of the chapter after block `b`. */
  const pagesLeftFrom = (n: number, b: number) => {
    const next = chapterTarget(book.toc, { b, o: 0 }, 1);
    return numbers && next !== null ? Math.max(0, pageOfPlace({ b: next, o: 0 }) - n) : null;
  };
  /** The page the slider at `f` stands for: the one shown where reading is, the first and last at its ends (the last converted so far, while converting). */
  const sliderPage = pageInfo ? (f: number) => Math.min(numbers!.ready, pageAtFraction(f, fraction, pageInfo.page, pageInfo.total)) : undefined;
  const pageLabel = sliderPage ? (f: number) => `Page ${sliderPage(f)} of ${pageInfo!.approx ? '~' : ''}${pageInfo!.total}` : undefined;
  const infoAt = (pagesLeft: number | null) =>
    !book.complete
      ? `Preparing book ${Math.round(book.progress * 100)}%`
      : pagesLeft
        ? `${pagesLeft} ${pagesLeft === 1 ? 'page' : 'pages'} left in chapter · ${formatMinutes(bookLeft)} left`
        : `${formatMinutes(bookLeft)} left in book`;
  const chromeInfo = infoAt(pageInfo ? pagesLeftFrom(pageInfo.page, pos.b) : null);
  // While the slider is dragged: the chapter and pages left where it would go.
  const dragChapter = (f: number) => book.chapterAt(book.blockAtFraction(f))?.t;
  const dragInfo = (f: number) => infoAt(sliderPage ? pagesLeftFrom(sliderPage(f), book.blockAtFraction(f)) : null);
  const backLabel = back
    ? pageInfo
      ? `Back to page ${back.shown && back.shown.key === pageInfo.key ? back.shown.page : numbers!.at(book.chunkOf(back.pos.b), back.f ?? book.fractionInChunk(back.pos))}`
      : `Back to ${Math.round(book.fraction(back.pos) * 100)}%`
    : '';
  return { prevChapter, nextChapter, footerRight, fraction, sliderPage, pageLabel, chromeInfo, dragChapter, dragInfo, backLabel };
}
