// Range arithmetic for highlights inside one block. Pure, so it is tested
// without the app.

export interface Ranged {
  id: string;
  b: number;
  s: number;
  e: number;
  /** The highlighted text: the block text from s to e. */
  text: string;
}

/**
 * Remove [s, e) of block `b` from every highlight. Highlights inside the range
 * disappear; ones overlapping an edge are trimmed; one spanning the whole
 * range is split in two (the right part gets `newId()`).
 */
export function cutRange<T extends Ranged>(list: T[], b: number, s: number, e: number, newId: () => string): T[] {
  const out: T[] = [];
  for (const h of list) {
    if (h.b !== b || h.e <= s || e <= h.s) {
      out.push(h);
      continue;
    }
    const part = (from: number, to: number, id: string): T => ({ ...h, id, s: from, e: to, text: h.text.slice(from - h.s, to - h.s) });
    const left = h.s < s;
    const right = e < h.e;
    if (left) out.push(part(h.s, s, h.id));
    if (right) out.push(part(e, h.e, left ? newId() : h.id));
  }
  return out;
}
