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
  /** Width of one text column; two side by side in a spread, `gap` apart. */
  column: number;
  gap: number;
  spread: boolean;
}

export interface Chunk {
  c: number;
  html: string;
  /** Characters in the chunk, for page numbers. */
  chars: number;
}

/** Where to show: a drawn point, or the first or last page of a chunk. */
export type Target = { at: DrawnPoint } | { chunk: number; edge: 'first' | 'last' };

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
  | { t: 'auto'; speed: number };

export type FromPage =
  | { t: 'ready' }
  /**
   * The page (page mode) or the top of the screen (scroll mode) shows from
   * `first`; the next page starts at `next`. `turned`: a page turn got here.
   * `key` is the layout it was laid out with.
   */
  | { t: 'shown'; first: DrawnPoint; next: DrawnPoint | null; chunk: number; turned: boolean; key: string; lastPage: boolean }
  /** Pages per chunk laid out (page mode), for page numbers; `page` is the column shown, counted in its chunk. */
  | { t: 'pages'; counts: { c: number; pages: number; chars: number }[]; chunk: number; page: number }
  /** The page needs these chunks (it reached the edge of what it has). */
  | { t: 'need'; chunks: number[] }
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
