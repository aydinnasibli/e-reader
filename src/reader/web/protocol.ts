// Messages between the reader screen (React Native) and the page that draws
// the book (src/reader/web/page, inside a WebView). Imported by both sides, so
// they can't disagree about what's sent.
//
// Positions on the page are drawn points: a block (its index in the book) and
// an offset in its drawn text (indent prefix and soft hyphens included; see
// look.ts drawn()). The screen converts them to and from book positions.

export interface DrawnPoint {
  b: number;
  i: number;
}

/** A caret on screen, in points from the top-left of the WebView. */
export interface PageCaret {
  x: number;
  y: number;
  h: number;
}

/** Where the text goes on the page. */
export interface PageFrame {
  /** The WebView's size. */
  width: number;
  height: number;
  /** Space before the text on the left (margin and any landscape notch) and after it on the right. */
  left: number;
  right: number;
  /** Space above and below the text (scroll mode: clear of the status bar and the badge). */
  top: number;
  bottom: number;
  /** Width of one text column; columns (pages) follow each other `column + gap` apart, two to a screen in a spread. */
  column: number;
  gap: number;
  spread: boolean;
  /**
   * Page mode: the notch or camera at each side. Pages are drawn only
   * between them, so a screen is `width - inset.left - inset.right` wide and
   * the middle of a spread is just the margins.
   */
  inset?: { left: number; right: number };
}

export interface Chunk {
  c: number;
  html: string;
  /** Characters in the chunk, for page numbers. */
  chars: number;
  /**
   * Page mode: the chunk goes on from chunk `c - 1` on that chunk's last page
   * instead of starting a page of its own (the two were cut apart only for
   * size, in the middle of a chapter; see html.ts joinsBefore). Never two in
   * a row, so a page depends on at most the chunk before it.
   */
  joins?: boolean;
}

/**
 * Where to show: a drawn point, the first or last page of a chunk, or a page
 * of a chunk by its index (page mode; scroll mode shows the chunk's start).
 * A point is shown on the page holding it (pages are always cut the same way:
 * page N always shows the same text); with `top` (the layout changed) its line
 * is also marked for a moment, to find the place read on the page.
 */
export type Target = { at: DrawnPoint; top?: boolean } | { chunk: number; edge: 'first' | 'last' } | { chunk: number; page: number };

export interface PageSetup {
  mode: 'page' | 'scroll';
  frame: PageFrame;
  /** The book's styles (fonts, sizes, colours), as CSS. */
  css: string;
  turn: 'slide' | 'fade' | 'none';
  tapForward: boolean;
  /** Text shown when there's nothing more yet (still converting), and at the end in scroll mode. */
  processing: string;
  theEnd: string;
  /** The book's language ('tr'), for the page's own language rules (Turkish i in ligatures, hyphens). */
  lang?: string;
}

/** A background mark, in drawn offsets of block `b`. */
export interface PageMark {
  b: number;
  s: number;
  e: number;
  color: string;
}

export type ToPage =
  /** Settings changed (or first time): lay everything out again and show `target`. */
  | { t: 'setup'; setup: PageSetup; target: Target; key: string }
  /** The chunks to show, replacing whatever was shown, and where. */
  | { t: 'content'; chunks: Chunk[]; target: Target; key: string }
  /** More chunks around the ones shown. */
  | { t: 'add'; chunks: Chunk[] }
  /** Chunks far from the place read, no longer needed. */
  | { t: 'drop'; chunks: number[] }
  /** The book's chunks are [0, count); `complete`: no more will come. */
  | { t: 'bounds'; count: number; complete: boolean }
  | { t: 'go'; target: Target }
  | { t: 'turn'; dir: 1 | -1 }
  | { t: 'marks'; marks: PageMark[] }
  /** The highlight tool: touches mark text instead of selecting it or turning pages; edge taps still turn. */
  | { t: 'tool'; marking: boolean }
  | { t: 'clearSelection' }
  /** Scroll mode: auto-scroll speed in points a second, 0 = off. */
  | { t: 'auto'; speed: number }
  /**
   * Page mode: how many pages these chunks take in the layout `key` (the
   * current setup's), each laid out as a chunk starting on a page of its own
   * (not joined), out of sight. Answered with 'measured'; not at all if `key`
   * isn't the layout the page has.
   */
  | { t: 'measure'; key: string; chunks: Chunk[] };

export type FromPage =
  | { t: 'ready' }
  /**
   * The page (page mode) or the top of the screen (scroll mode) shows from
   * `first`, in chunk `chunk`; the next page starts at `next`. `turned`: a
   * page turn got here. `key` is the layout it was laid out with.
   */
  | { t: 'shown'; first: DrawnPoint; next: DrawnPoint | null; chunk: number; turned: boolean; key: string; lastPage: boolean }
  /**
   * Pages per chunk laid out (page mode), for page numbers. A page belongs to
   * the chunk of its first character, so a chunk's pages are the ones that
   * start in it: where a chunk goes on from the one before (Chunk.joins), the
   * page they share is the earlier chunk's last, and a short chunk can have
   * none. `chunk` and `page` are the chunk of the page shown (in a spread, the
   * left-hand one) and its index among that chunk's pages; `span` is how many
   * pages are showing (2 in a spread whose right-hand page has text; absent: 1).
   */
  | { t: 'pages'; counts: { c: number; pages: number; chars: number }[]; chunk: number; page: number; span?: 1 | 2 }
  /** The page needs these chunks (it reached the edge of what it has). */
  | { t: 'need'; chunks: number[] }
  /** The answer to 'measure': pages (columns, as in 'pages') each chunk takes on its own in layout `key`. */
  | { t: 'measured'; key: string; counts: { c: number; pages: number }[] }
  /** A tap in the middle (page mode), or anywhere off a link (scroll mode). */
  | { t: 'tap' }
  | { t: 'link'; target: string }
  /** A forward turn on the last page of the book. */
  | { t: 'end' }
  /** Scroll mode: the end of the book is in view. */
  | { t: 'reachEnd' }
  | { t: 'autoInterrupt' }
  | { t: 'autoEnd' }
  /** Text selected (whole words not required: the browser's own selection). `end` is exclusive. */
  | { t: 'selection'; start: DrawnPoint; end: DrawnPoint; startCaret: PageCaret; endCaret: PageCaret }
  | { t: 'noSelection' }
  /** The highlight tool: a tap on text (null: off the text). */
  | { t: 'markTap'; at: DrawnPoint | null }
  /** The highlight tool: dragged from `from` to `to`; nulls = cancelled; `done` when lifted. */
  | { t: 'markDrag'; from: DrawnPoint | null; to: DrawnPoint | null; done: boolean }
  | { t: 'error'; message: string };
