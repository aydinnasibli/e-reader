// Range arithmetic for highlights inside one block. Pure, so it is tested
// without the app.

export interface Ranged {
  id: string;
  b: number;
  s: number;
  e: number;
  /** The highlighted text: the block text from s to e. */
  text: string;
  note?: string;
}

/**
 * Remove [s, e) of block `b` from every highlight. Highlights inside the range
 * disappear; ones overlapping an edge are trimmed (and lose the spaces left at
 * their cut ends); one spanning the whole
 * range is split in two: the right part gets `newId()`, and the note stays
 * with the left one (it would be shown twice otherwise).
 */
export function cutRange<T extends Ranged>(list: T[], b: number, s: number, e: number, newId: () => string): T[] {
  const out: T[] = [];
  for (const h of list) {
    if (h.b !== b || h.e <= s || e <= h.s) {
      out.push(h);
      continue;
    }
    // What's left of a highlight, without the spaces at its ends (none if only spaces).
    const part = (from: number, to: number, id: string): T | null => {
      const t = h.text.slice(from - h.s, to - h.s);
      const lead = t.length - t.trimStart().length;
      const kept = t.trim();
      return kept ? { ...h, id, s: from + lead, e: from + lead + kept.length, text: kept } : null;
    };
    const left = h.s < s ? part(h.s, s, h.id) : null;
    const right = e < h.e ? part(e, h.e, left ? newId() : h.id) : null;
    if (left) out.push(left);
    if (right) out.push(left ? { ...right, note: undefined } : right);
  }
  return out;
}
