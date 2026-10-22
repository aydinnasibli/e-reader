// Background marks (highlights, search hits) drawn over runs of text.
// Marks never change layout, so measured pages stay valid.

import { LINK, type Run, runLink, runStyle, runText } from '@/engine/types';

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
  /** Internal link target (footnote). */
  link?: string;
}

/**
 * Split runs at mark boundaries. `toRuns` converts a mark's block offset into
 * an offset in `runs` (which may be a drawn, hyphenated slice of the block).
 */
export function applyMarks(runs: Run[], marks: Mark[] | undefined, toRuns: (o: number) => number): Segment[] {
  const seg = (r: Run, text: string, bg?: string): Segment => {
    const link = runLink(r);
    const s: Segment = { text, bits: runStyle(r) & ~LINK };
    if (bg) s.bg = bg;
    if (link) s.link = link;
    return s;
  };
  if (!marks || !marks.length) return runs.map((r) => seg(r, runText(r)));
  const ms = marks.map((m) => ({ s: toRuns(m.s), e: toRuns(m.e), color: m.color }));
  const cuts = new Set<number>();
  for (const m of ms) {
    cuts.add(m.s);
    cuts.add(m.e);
  }
  const out: Segment[] = [];
  let pos = 0;
  for (const r of runs) {
    const t = runText(r);
    const end = pos + t.length;
    let from = pos;
    const inner = [...cuts].filter((c) => c > pos && c < end).sort((a, b) => a - b);
    for (const cut of [...inner, end]) {
      if (cut > from) {
        let bg: string | undefined;
        for (const m of ms) if (m.s <= from && from < m.e) bg = m.color;
        out.push(seg(r, t.slice(from - pos, cut - pos), bg));
      }
      from = cut;
    }
    pos = end;
  }
  return out;
}
