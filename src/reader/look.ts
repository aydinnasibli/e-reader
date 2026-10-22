// How each kind of block looks. Measuring (for pagination) and drawing use
// exactly these values, so a measured page is the page you see.

import { Platform, type TextStyle } from 'react-native';
import { BOLD, type Block, ITALIC, MONO, type Run, SUB, SUP, runStyle, runText } from '@/engine/types';
import type { ReaderSettings } from '@/lib/settings';

export interface Look {
  fontSize: number;
  lineHeight: number;
  fontFamily?: string;
  fontWeight?: TextStyle['fontWeight'];
  textAlign: TextStyle['textAlign'];
  marginTop: number;
  marginBottom: number;
  paddingLeft: number;
  /** Text prepended to the block (first-line indent). */
  prefix: string;
}

const SERIF = Platform.select({ ios: 'Georgia', android: 'serif', default: 'serif' });
const MONO_FONT = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
const INDENT = '  ';

export function baseFont(s: ReaderSettings) {
  return s.font === 'serif' ? SERIF : undefined;
}

export function lineHeightOf(s: ReaderSettings) {
  return Math.round(s.fontSize * s.lineSpacing);
}

export function lookOf(b: Block, s: ReaderSettings): Look {
  const fs = s.fontSize;
  const lh = lineHeightOf(s);
  const gap = s.indent ? 0 : Math.round(lh * 0.5);
  const body: Look = {
    fontSize: fs,
    lineHeight: lh,
    fontFamily: baseFont(s),
    textAlign: s.justify ? 'justify' : 'left',
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
      const hlh = Math.round(size * 1.3);
      return {
        ...body,
        fontSize: size,
        lineHeight: hlh,
        fontWeight: '700',
        textAlign: 'center',
        marginTop: b.c ? 0 : Math.round(lh * (level <= 2 ? 1.5 : 1)),
        marginBottom: Math.round(lh * 0.6),
        prefix: '',
      };
    }
    case 'q':
      return { ...body, fontSize: Math.round(fs * 0.94), paddingLeft: Math.round(fs * 1.5), marginTop: b.c ? 0 : Math.round(lh * 0.3), prefix: '' };
    case 'v':
      return { ...body, textAlign: 'left', paddingLeft: Math.round(fs * 1.5), marginTop: 0, prefix: '' };
    case 'pre': {
      const size = Math.round(fs * 0.82);
      return { ...body, fontSize: size, lineHeight: Math.round(size * 1.35), fontFamily: MONO_FONT, textAlign: 'left', prefix: '' };
    }
    default:
      return body;
  }
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
  return {
    fontWeight: bits & BOLD ? '700' : undefined,
    fontStyle: bits & ITALIC ? 'italic' : undefined,
    fontFamily: bits & MONO ? MONO_FONT : undefined,
    fontSize: bits & (SUP | SUB) ? Math.round(look.fontSize * 0.7) : undefined,
  };
}

export { runStyle, runText };
