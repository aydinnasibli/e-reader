// Page numbers for books far too big to paginate whole. Where a chunk starts
// is estimated from how many characters fit on a page in the chunks that are
// laid out; inside a chunk pages count up one by one. Pure, so it's tested.

/** Average characters per page over the laid-out chunks, or null if none yet. */
export function charsPerPage(samples: { chars: number; pages: number }[]): number | null {
  let chars = 0;
  let pages = 0;
  for (const s of samples) {
    if (s.pages > 0 && s.chars > 0) {
      chars += s.chars;
      pages += s.pages;
    }
  }
  return pages ? chars / pages : null;
}

/**
 * Number (1-based) of page `index` of a chunk that starts `chunkFirstChar`
 * characters in and holds `chunkChars`. Pages count up one by one from the
 * chunk's first number; a chunk with more pages than its share stops short of
 * the next chunk's first number (its last pages share a number) rather than
 * run into it, so numbers never go backwards. One with fewer pages skips
 * ahead to the next chunk's numbers.
 */
export function pageNumber(chunkFirstChar: number, chunkChars: number, index: number, cpp: number): number {
  const first = Math.floor(chunkFirstChar / cpp) + 1;
  const next = Math.floor((chunkFirstChar + chunkChars) / cpp) + 1;
  return Math.min(first + index, Math.max(first, next - 1));
}

export function pageCount(totalChars: number, cpp: number): number {
  return Math.max(1, Math.round(totalChars / cpp));
}

/** Pages from one character offset to another (e.g. to the next chapter). */
export function pagesBetween(from: number, to: number, cpp: number): number {
  return Math.max(0, Math.ceil((to - from) / cpp));
}
