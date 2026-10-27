// A picture's size in pixels from the first bytes of its file (JPEG, PNG,
// GIF, WebP, BMP), without decoding it: how much of a page it takes decides
// its share of the page numbers (see blockWeight in writer.ts).

import { be16, be32, le16, le32 } from './bytes';
import { pictureLines } from './writer';

/** Width and height, or null if the bytes don't say (another format, or the size comes later in the file). */
export function pictureSize(b: Uint8Array): [number, number] | null {
  if (b.length < 26) return null;
  // PNG: the IHDR chunk comes first.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return valid(be32(b, 16), be32(b, 20));
  // GIF87a / GIF89a: the logical screen.
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return valid(le16(b, 6), le16(b, 8));
  // BMP: BITMAPINFOHEADER (height negative for top-down).
  if (b[0] === 0x42 && b[1] === 0x4d) return valid(Math.abs(le32(b, 18) | 0), Math.abs(le32(b, 22) | 0));
  // WebP: RIFF....WEBP then a VP8 / VP8L / VP8X chunk.
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45 && b.length >= 30) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === 'VP8 ') return valid(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
    if (kind === 'VP8L') return valid(1 + (((b[22] & 0x3f) << 8) | b[21]), 1 + (((b[24] & 0xf) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)));
    if (kind === 'VP8X') return valid(1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16)));
    return null;
  }
  // JPEG: walk the segments to the first start-of-frame.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1];
      if (m === 0xff) {
        i++;
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2;
        continue;
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return valid(be16(b, i + 7), be16(b, i + 5));
      i += 2 + be16(b, i + 2);
    }
  }
  return null;
}

function valid(w: number, h: number): [number, number] | null {
  return w > 0 && h > 0 && w < 100_000 && h < 100_000 ? [w, h] : null;
}

/** Bytes of pictures read for their sizes between two pauses. */
const PROBE_BUDGET = 64 * 1024;
/** How much of a JPEG is read when its size comes after its metadata. */
const JPEG_MORE = 16 * 1024;

/**
 * The page space pictures take, from the sizes their first bytes give.
 * Reading (and inflating) them happens in the middle of a slice of text, so
 * only so much is read between two pauses; past that a picture counts as an
 * average one. (A chapter of 300 photos would otherwise freeze the app.)
 */
export class PictureProbe {
  private budget = PROBE_BUDGET;

  /** There's some of the budget left: a picture's first bytes may be read. */
  get open(): boolean {
    return this.budget > 0;
  }

  /** A pause came: the budget starts over. */
  reset() {
    this.budget = PROBE_BUDGET;
  }

  /**
   * The lines (pictureLines) a picture of `total` bytes takes, from its first
   * bytes `head`; undefined if they don't say. A JPEG's size can come after
   * its metadata: `more(n)` gives its first n bytes, read if there's room.
   */
  lines(head: Uint8Array, total: number, more: (n: number) => Uint8Array): number | undefined {
    this.budget -= head.length;
    let size = pictureSize(head);
    if (!size && head[0] === 0xff && total > head.length && this.budget >= JPEG_MORE) {
      const longer = more(JPEG_MORE);
      this.budget -= longer.length;
      size = pictureSize(longer);
    }
    return size ? pictureLines(size[0], size[1]) : undefined;
  }
}
