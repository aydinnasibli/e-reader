// Numbers read out of file headers: ZIP stores them little-endian, Palm
// databases (MOBI) and most picture formats big-endian. A read past the end
// of the bytes gives what JavaScript makes of the missing ones (0 in the
// shifts, NaN in the 32-bit sums), which the formats' checks then reject.

export const le16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
export const le32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
export const le64 = (b: Uint8Array, o: number) => le32(b, o) + le32(b, o + 4) * 0x100000000;
export const be16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
export const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
