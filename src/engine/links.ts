// Links inside a book, for the EPUB and FB2 converters: where each element
// id is, and where the links that aren't notes go (Manifest.anchors and
// Manifest.anchorOffsets). Which links are notes each format decides itself.

import { type Position, record } from './types';

export class LinkTargets {
  /** Where each id is (the first time it's seen): its block, and its exact place when it's inside the text (a note's mark). */
  private block = new Map<string, number>();
  private place = new Map<string, Position>();
  readonly anchors = record<number>();
  readonly anchorOffsets = record<number>();

  has(key: string): boolean {
    return this.block.has(key);
  }

  /** The id `key` is in block `b`, at `place` (BookWriter.mark) when that isn't the block's start. Only the first time counts. */
  see(key: string, b: number, place: Position | null) {
    if (this.block.has(key)) return;
    this.block.set(key, b);
    if (place) this.place.set(key, place);
  }

  /** The block the id is in, if it has been seen. */
  blockOf(key: string): number | undefined {
    return this.place.get(key)?.b ?? this.block.get(key);
  }

  /** Link `key` goes to block `b`: to the id's own place there when it's inside that block's text. */
  anchor(key: string, b: number) {
    const place = this.place.get(key);
    this.anchors[key] = b;
    if (place?.b === b && place.o > 0) this.anchorOffsets[key] = place.o;
  }

  /** Link `key` goes to where its id is, if the id is in the book's `total` blocks. */
  anchorAtId(key: string, total: number) {
    const b = this.blockOf(key);
    if (b !== undefined && b < total) this.anchor(key, b);
  }
}
