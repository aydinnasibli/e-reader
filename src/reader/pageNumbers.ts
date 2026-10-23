// Page numbers for books far too big to paginate whole. Pages are counted
// exactly inside the chunks that are laid out; everything else is estimated
// from how many characters fit on a page there. Pure, so it's tested.

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
 * Number (1-based) of page `index` of the `pages` pages of a chunk that starts
 * `chunkFirstChar` characters in and holds `chunkChars`. The chunk's pages are
 * spread evenly over its characters, so numbers only ever go up as you read,
 * also from one chunk into the next (a chunk with more pages than average
 * can't run into the next chunk's numbers).
 */
export function pageNumber(chunkFirstChar: number, chunkChars: number, index: number, pages: number, cpp: number): number {
  const at = chunkFirstChar + (pages > 0 ? (index * chunkChars) / pages : 0);
  return Math.floor(at / cpp) + 1;
}

export function pageCount(totalChars: number, cpp: number): number {
  return Math.max(1, Math.round(totalChars / cpp));
}

/** Pages from one character offset to another (e.g. to the next chapter). */
export function pagesBetween(from: number, to: number, cpp: number): number {
  return Math.max(0, Math.ceil((to - from) / cpp));
}
