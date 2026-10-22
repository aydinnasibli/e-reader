// Background marks (highlights, search hits) drawn over runs of text.
// Marks never change layout, so measured pages stay valid.

import { type Run, runStyle, runText } from '@/engine/types';

export interface Mark {
  /** [s, e) in the block's own text (without the indent prefix). */
  s: number;
  e: number;
  color: string;
}

export interface Segment {
  text: string;
  bits: number;
  bg?: string;
}

/**
 * Split runs at mark boundaries. `shift` converts a mark's block offset into
 * the coordinates of `runs` (indent prefix length minus the start of the
 * drawn slice).
 */
export function applyMarks(runs: Run[], marks: Mark[] | undefined, shift: number): Segment[] {
  if (!marks || !marks.length) return runs.map((r) => ({ text: runText(r), bits: runStyle(r) }));
  const ms = marks.map((m) => ({ s: m.s + shift, e: m.e + shift, color: m.color }));
  const cuts = new Set<number>();
  for (const m of ms) {
    cuts.add(m.s);
    cuts.add(m.e);
  }
  const out: Segment[] = [];
  let pos = 0;
  for (const r of runs) {
    const t = runText(r);
    const bits = runStyle(r);
    const end = pos + t.length;
    let from = pos;
    const inner = [...cuts].filter((c) => c > pos && c < end).sort((a, b) => a - b);
    for (const cut of [...inner, end]) {
      if (cut > from) {
        let bg: string | undefined;
        for (const m of ms) if (m.s <= from && from < m.e) bg = m.color;
        out.push({ text: t.slice(from - pos, cut - pos), bits, bg });
      }
      from = cut;
    }
    pos = end;
  }
  return out;
}
