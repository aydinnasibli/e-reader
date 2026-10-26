// A picture's size in pixels from the first bytes of its file (JPEG, PNG,
// GIF, WebP, BMP), without decoding it: how much of a page it takes decides
// its share of the page numbers (see blockWeight in writer.ts).

const be16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const le16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const le32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;

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
