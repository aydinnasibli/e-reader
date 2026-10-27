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

/** The font's faces the text uses: its weight (regular or medium) and bold, upright and italic. */
function fontFaces(font: WebFont, weight: number): string {
  if (!font.faces) return font.css;
  return font.faces
    .filter((f) => f.weight === weight || f.weight === 700)
    .map((f) => f.css)
    .join('');
}

export function bookCss(settings: ReaderSettings, theme: Theme, frame: PageFrame, font: WebFont, mode: 'page' | 'scroll'): string {
  const weight = settings.weight === 'medium' && font.medium ? 500 : 400;
  let css = fontFaces(font, weight);
  css += `html,body{background:${theme.bg};color:${theme.text};}`;
  css += `body{font-family:${font.family};font-weight:${weight};}`;
  // Text selected and its handles (page/selection.ts); the line read, marked for a moment after the layout changed (page/flash.ts).
  css += `:root{--sel:${theme.accent}55;--knob:${theme.accent};--flash:${theme.accent}33;}`;
  const lh = lineHeightOf(settings);
  const gap = lookOf({ k: 'p', r: [''] }, settings).marginTop;
  for (const b of KINDS) {
    const cls = blockClass(b);
    const look = lookOf(b, settings);
    css += rule(`.${cls}`, look, cls === 'pre' ? `font-family:${MONO_FAMILY};` : '');
    if (b.k === 'h') {
      // A heading keeps room under it (base.css): until the page measures what follows it
      // (paged.ts, --keep), the space after it and three lines.
      const keep = `var(--keep,${Math.max(look.marginBottom, gap) + 3 * lh + 1}px)`;
      css += `.${cls}::after{height:${keep};margin-bottom:calc(${keep} * -1);}`;
    }
  }
  css += `.c{margin-top:0;}`;
  // The book's own alignment (look.ts honours it the same way).
  css += `.ac{text-align:center;}.ar{text-align:right;}`;
  css += `.b{font-weight:700;}.i{font-style:italic;}.sc{font-variant-caps:small-caps;}.mono{font-family:${MONO_FAMILY};}.a{color:${theme.accent};}`;
  css += `.sup,.sub{font-size:${Math.round(settings.fontSize * 0.7)}px;}`;
  css += `.sp,.hr{height:${lh}px;}.hr i{background:${theme.muted};}`;
  css += `.end{color:${theme.muted};}`;
  if (mode === 'page') {
    // Pictures fit a page (html.ts sizes them by it); a body line and the space between paragraphs, for the page's measures.
    css += `:root{--page-h:${frame.height}px;--line:${lh}px;--gap:${gap}px;}`;
    // Pages are drawn between the notch and the camera: a screen is that wide.
    const inset = frame.inset ?? { left: 0, right: 0 };
    const screen = frame.width - inset.left - inset.right;
    css += `html[data-mode='page'] #viewport{left:${inset.left}px;width:${screen}px;right:auto;}`;
    css += `#strip>.chunk{width:${screen}px;height:${frame.height}px;padding:0 ${frame.right - inset.right}px 0 ${frame.left - inset.left}px;column-width:${frame.column}px;column-gap:${frame.gap}px;}`;
  } else {
    css += `:root{--page-h:${Math.round(frame.height * 0.9)}px;}`;
    css += `#flow{padding:${frame.top}px ${frame.right}px ${frame.bottom}px ${frame.left}px;}`;
  }
  return css;
}
