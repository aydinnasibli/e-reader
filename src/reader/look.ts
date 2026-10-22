// How each kind of block looks. Measuring (for pagination) and drawing use
// exactly these values, so a measured page is the page you see.

import type { TextStyle } from 'react-native';
import { BOLD, type Block, ITALIC, MONO, type Run, SUB, SUP, makeRun, runLink, runStyle, runText } from '@/engine/types';
import { type Weight, fontFace } from '@/lib/fonts';
import type { ReaderSettings } from '@/lib/settings';
import { Platform } from 'react-native';
import { hyphenPoints, pickLanguage } from './hyphenate';

export interface Look {
  fontSize: number;
  lineHeight: number;
  /** Font id and weight; the concrete family comes from fontFace(). */
  font: string;
  weight: Weight;
  bold: boolean;
  letterSpacing: number;
  textAlign: TextStyle['textAlign'];
  marginTop: number;
  marginBottom: number;
  paddingLeft: number;
  /** Text prepended to the block (first-line indent). */
  prefix: string;
  /** Hyphenate: the book's language code, or '' to guess from the text. Undefined = off. */
  hyph?: string;
}

const MONO_FONT = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
const INDENT = '  ';

export function lineHeightOf(s: ReaderSettings) {
  return Math.round(s.fontSize * s.lineSpacing);
}

/** Everything that changes where lines break; part of the page cache key. */
export function layoutKeyOf(s: ReaderSettings) {
  return [s.fontSize, s.lineSpacing, s.letterSpacing, s.paraSpacing, s.font, s.weight, s.align, s.indent, s.hyphenate].join('|');
}

/** `lang` is the book's language (from its metadata), used for hyphenation. */
export function lookOf(b: Block, s: ReaderSettings, lang?: string): Look {
  const fs = s.fontSize;
  const lh = lineHeightOf(s);
  const gap = Math.round(lh * s.paraSpacing);
  const body: Look = {
    fontSize: fs,
    lineHeight: lh,
    font: s.font,
    weight: s.weight,
    bold: false,
    letterSpacing: s.letterSpacing,
    textAlign: s.align,
    marginTop: b.c ? 0 : gap,
    marginBottom: 0,
    paddingLeft: 0,
    prefix: s.indent && !b.c ? INDENT : '',
    hyph: s.hyphenate && (b.k === 'p' || b.k === 'q' || b.k === 'v') ? (lang ?? '') : undefined,
  };
  switch (b.k) {
    case 'h': {
      const level = b.l ?? 1;
      const scale = level === 1 ? 1.45 : level === 2 ? 1.3 : level === 3 ? 1.15 : 1.05;
      const size = Math.round(fs * scale);
      return {
        ...body,
        fontSize: size,
        lineHeight: Math.round(size * 1.3),
        bold: true,
        textAlign: 'center',
        marginTop: b.c ? 0 : Math.round(lh * (level <= 2 ? 1.5 : 1)),
        marginBottom: Math.round(lh * 0.6),
        prefix: '',
      };
    }
    case 'q':
      return { ...body, fontSize: Math.round(fs * 0.94), paddingLeft: Math.round(fs * 1.5), marginTop: b.c ? 0 : Math.max(gap, Math.round(lh * 0.3)), prefix: '' };
    case 'v':
      return { ...body, textAlign: 'left', paddingLeft: Math.round(fs * 1.5), marginTop: 0, prefix: '' };
    case 'pre': {
      const size = Math.round(fs * 0.82);
      return { ...body, fontSize: size, lineHeight: Math.round(size * 1.35), textAlign: 'left', letterSpacing: 0, prefix: '' };
    }
    default:
      return body;
  }
}

/** Base text style for a block (font family resolved for the chosen font). */
export function baseTextStyle(look: Look, isPre = false): TextStyle {
  if (isPre) return { fontFamily: MONO_FONT };
  return fontFace(look.font, look.weight, look.bold, false);
}

/**
 * A block as drawn: indent prefix first, then the text with soft hyphens
 * inserted when hyphenating. Positions in the book (block text offsets) and
 * on screen (drawn offsets) are converted with toDrawn()/toBlock().
 */
export interface Drawn {
  runs: Run[];
  text: string;
  prefix: number;
  /** Block offsets with a soft hyphen inserted before them, ascending. */
  hyphens: number[];
}

const drawnCache = new WeakMap<Block, Map<string, Drawn>>();

export function drawn(b: Block, look: Look): Drawn {
  const key = `${look.prefix}|${look.hyph ?? '-'}`;
  let perBlock = drawnCache.get(b);
  const hit = perBlock?.get(key);
  if (hit) return hit;
  let runs = b.r ?? [];
  let hyphens: number[] = [];
  if (look.hyph !== undefined && runs.length) {
    let text = '';
    for (const r of runs) text += runText(r);
    const lang = pickLanguage(look.hyph || undefined, text);
    if (lang) hyphens = hyphenPoints(text, lang);
    if (hyphens.length) runs = insertSoftHyphens(runs, hyphens);
  }
  if (look.prefix) runs = [look.prefix, ...runs];
  let text = '';
  for (const r of runs) text += runText(r);
  const d: Drawn = { runs, text, prefix: look.prefix.length, hyphens };
  if (!perBlock) drawnCache.set(b, (perBlock = new Map()));
  perBlock.set(key, d);
  return d;
}

function insertSoftHyphens(runs: Run[], points: number[]): Run[] {
  const out: Run[] = [];
  let pos = 0;
  let k = 0;
  for (const r of runs) {
    const t = runText(r);
    let piece = '';
    let from = 0;
    while (k < points.length && points[k] < pos + t.length) {
      const at = points[k] - pos;
      piece += t.slice(from, at) + '\u00ad';
      from = at;
      k++;
    }
    piece += t.slice(from);
    out.push(makeRun(piece, runStyle(r), runLink(r)));
    pos += t.length;
  }
  return out;
}

/** Book offset -> drawn offset. */
export function toDrawn(d: Drawn, o: number): number {
  let n = 0;
  while (n < d.hyphens.length && d.hyphens[n] <= o) n++;
  return d.prefix + o + n;
}

/** Drawn offset -> book offset. */
export function toBlock(d: Drawn, i: number): number {
  const k = i - d.prefix;
  if (k <= 0) return 0;
  // Hyphen n sits at drawn (unprefixed) offset hyphens[n] + n.
  let n = 0;
  while (n < d.hyphens.length && d.hyphens[n] + n < k) n++;
  return k - n;
}

export function drawnRuns(b: Block, look: Look): Run[] {
  return drawn(b, look).runs;
}

export function drawnText(b: Block, look: Look): string {
  return drawn(b, look).text;
}

export function runTextStyle(bits: number, look: Look): TextStyle | undefined {
  if (!bits) return undefined;
  const face = bits & MONO ? { fontFamily: MONO_FONT } : bits & (BOLD | ITALIC) ? fontFace(look.font, look.weight, look.bold || !!(bits & BOLD), !!(bits & ITALIC)) : undefined;
  return {
    ...face,
    fontSize: bits & (SUP | SUB) ? Math.round(look.fontSize * 0.7) : undefined,
  };
}

export { runStyle, runText };
