// A block's character widths as drawn: each run in its own font (bold,
// italic, small for superscripts), at the block's size and letter spacing.

import { BOLD, type Block, ITALIC, MONO, SUB, SUP, runStyle, runText } from '@/engine/types';
import { type Face, charWidth, prepareWidths, wordWidth } from './charWidths';
import type { Metrics } from './hitTest';
import { type Look, baseTextStyle, drawn, runTextStyle } from './look';

interface Span {
  end: number;
  face: Face;
  size: number;
}

function spans(b: Block, look: Look): Span[] {
  const base = baseTextStyle(look, b.k === 'pre');
  const out: Span[] = [];
  let pos = 0;
  for (const r of drawn(b, look).runs) {
    pos += runText(r).length;
    const bits = runStyle(r);
    const st = bits & (BOLD | ITALIC | MONO | SUP | SUB) ? runTextStyle(bits, look) : undefined;
    const face: Face = { fontFamily: st?.fontFamily ?? base.fontFamily, fontWeight: st?.fontWeight ?? base.fontWeight, fontStyle: st?.fontStyle ?? base.fontStyle };
    out.push({ end: pos, face, size: st?.fontSize ?? look.fontSize });
  }
  return out;
}

const ALIGN: Record<string, Metrics['align']> = { center: 'center', right: 'right', justify: 'justify' };

export function metricsOf(b: Block, look: Look): Metrics {
  const text = drawn(b, look).text;
  const ss = spans(b, look);
  let at = 0;
  const spanOf = (i: number) => {
    // Lookups go along a line, so start from the last span found.
    if (ss[at] && i >= (at ? ss[at - 1].end : 0) && i < ss[at].end) return ss[at];
    at = ss.findIndex((s) => i < s.end);
    if (at < 0) at = ss.length - 1;
    return ss[at];
  };
  const advance = (i: number) => {
    const ch = text[i];
    if (ch === undefined || ch === '­' || ch === '\n') return 0;
    const s = spanOf(i);
    return s ? charWidth(s.face, ch, s.size) + look.letterSpacing : 0;
  };
  // The first word looked up has all of the paragraph's words measured, so a
  // handle dragged on to its other lines doesn't jump when they arrive.
  let asked = false;
  const askAll = () => {
    asked = true;
    let from = 0;
    for (const sp of ss) {
      for (const w of text.slice(from, sp.end).replace(/[\u00ad]/g, '').split(/\s+/)) if (w) wordWidth(sp.face, w, sp.size);
      from = sp.end;
    }
  };
  /** A word drawn together, in one font: its measured width (asked for when not known yet). */
  const word = (i: number, j: number) => {
    if (!asked) askAll();
    const s = spanOf(i);
    if (!s || spanOf(j - 1) !== s) return undefined; // the font changes inside it
    const w = text.slice(i, j).replace(/[\u00ad\n]/g, '');
    const together = wordWidth(s.face, w, s.size);
    return together === undefined ? undefined : together + look.letterSpacing * w.length;
  };
  const first = ss[0];
  return {
    advance,
    word,
    hyphen: first ? charWidth(first.face, '-', first.size) + look.letterSpacing : 0,
    align: ALIGN[look.textAlign ?? ''] ?? 'left',
  };
}

/** Have a block's characters measured, so selecting it is exact from the first touch. */
export function prepareBlock(b: Block, look: Look) {
  if (!b.r?.length) return;
  const text = drawn(b, look).text;
  const ss = spans(b, look);
  let from = 0;
  for (const s of ss) {
    prepareWidths(s.face, text.slice(from, s.end));
    from = s.end;
  }
  prepareWidths(ss[0].face, '-');
}
