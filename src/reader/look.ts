// How each kind of block looks. Measuring (for pagination) and drawing use
// exactly these values, so a measured page is the page you see.

import type { TextStyle } from 'react-native';
import { BOLD, type Block, ITALIC, MONO, type Run, SUB, SUP, runStyle, runText } from '@/engine/types';
import { type Weight, fontFace } from '@/lib/fonts';
import type { ReaderSettings } from '@/lib/settings';
import { Platform } from 'react-native';

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
}

const MONO_FONT = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
const INDENT = '  ';

export function lineHeightOf(s: ReaderSettings) {
  return Math.round(s.fontSize * s.lineSpacing);
}

/** Everything that changes where lines break; part of the page cache key. */
export function layoutKeyOf(s: ReaderSettings) {
  return [s.fontSize, s.lineSpacing, s.letterSpacing, s.paraSpacing, s.font, s.weight, s.align, s.indent].join('|');
}

export function lookOf(b: Block, s: ReaderSettings): Look {
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

/** The runs as drawn: indent prefix first. */
export function drawnRuns(b: Block, look: Look): Run[] {
  const runs = b.r ?? [];
  return look.prefix ? [look.prefix, ...runs] : runs;
}

export function drawnText(b: Block, look: Look): string {
  let s = look.prefix;
  for (const r of b.r ?? []) s += runText(r);
  return s;
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
