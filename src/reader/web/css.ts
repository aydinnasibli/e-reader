// The book's look as CSS for the page: the same values look.ts gives the
// native text (sizes, spacing, alignment per kind of block), the reading
// font, the theme's colours, and where the text goes (frame).

import type { Block } from '@/engine/types';
import type { ReaderSettings, Theme } from '@/lib/settings';
import { type Look, lineHeightOf, lookOf } from '../look';
import type { PageFrame } from './protocol';
import { blockClass } from './html';
import { MONO_FAMILY, type WebFont } from './webFonts';

const KINDS: Block[] = [
  { k: 'p', r: [''] },
  { k: 'q', r: [''] },
  { k: 'v', r: [''] },
  { k: 'pre', r: [''] },
  ...[1, 2, 3, 4, 5, 6].map((l): Block => ({ k: 'h', l, r: [''] })),
];

function rule(sel: string, look: Look, extra = '') {
  return (
    `${sel}{font-size:${look.fontSize}px;line-height:${look.lineHeight}px;letter-spacing:${look.letterSpacing}px;` +
    `text-align:${look.textAlign ?? 'left'};margin-top:${look.marginTop}px;margin-bottom:${look.marginBottom}px;` +
    `padding-left:${look.paddingLeft}px;${look.bold ? 'font-weight:700;' : ''}${extra}}`
  );
}

export function bookCss(settings: ReaderSettings, theme: Theme, frame: PageFrame, font: WebFont, mode: 'page' | 'scroll'): string {
  const weight = settings.weight === 'medium' && font.medium ? 500 : 400;
  let css = font.css;
  css += `html,body{background:${theme.bg};color:${theme.text};}`;
  css += `body{font-family:${font.family};font-weight:${weight};}`;
  css += `::selection{background:${theme.accent}55;}`;
  for (const b of KINDS) {
    const cls = blockClass(b);
    css += rule(`.${cls}`, lookOf(b, settings), cls === 'pre' ? `font-family:${MONO_FAMILY};` : '');
  }
  css += `.c{margin-top:0;}`;
  css += `.b{font-weight:700;}.i{font-style:italic;}.mono{font-family:${MONO_FAMILY};}.a{color:${theme.accent};}`;
  css += `.sup,.sub{font-size:${Math.round(settings.fontSize * 0.7)}px;}`;
  const lh = lineHeightOf(settings);
  css += `.sp,.hr{height:${lh}px;}.hr i{background:${theme.muted};}`;
  css += `.end{color:${theme.muted};}`;
  if (mode === 'page') {
    css += `#strip>.chunk{width:${frame.width}px;height:${frame.height}px;padding:0 ${frame.right}px 0 ${frame.left}px;column-width:${frame.column}px;column-gap:${frame.gap}px;}`;
    css += `.img img{max-height:${frame.height}px;}`;
  } else {
    css += `#flow{padding:${frame.top}px ${frame.right}px ${frame.bottom}px ${frame.left}px;}`;
    css += `.img img{max-height:${Math.round(frame.height * 0.9)}px;}`;
  }
  return css;
}
