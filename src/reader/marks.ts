// Background marks (highlights, search hits) over a block's text. The reader
// page draws them (src/reader/web/page/marks.ts).

export interface Mark {
  /** [s, e) in the block's own text (without the indent prefix). */
  s: number;
  e: number;
  color: string;
}
