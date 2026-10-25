// Highlights and search hits as backgrounds behind text. With the CSS Custom
// Highlight API (Chrome 105+, Safari 17.2+) nothing in the page changes, so
// a selection being made isn't disturbed; older WebViews get spans wrapped
// around the text instead.

import type { PageMark } from '../protocol';
import { rangeOf } from './text';

type HighlightRegistry = Map<string, unknown> & { clear(): void };
type HighlightCtor = new (...ranges: Range[]) => unknown;
const registry = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;
const HighlightClass = (globalThis as { Highlight?: HighlightCtor }).Highlight;
export const nativeHighlights = !!registry && !!HighlightClass;

let current: PageMark[] = [];

function style(): HTMLStyleElement {
  let el = document.getElementById('marks') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = 'marks';
    document.head.appendChild(el);
  }
  return el;
}

function unwrap() {
  for (const span of [...document.querySelectorAll('span[data-mark]')]) {
    const parent = span.parentNode!;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  }
}

/** Wrap the text of a range in spans with a background, node by node. */
function wrap(r: Range, color: string) {
  const walker = document.createTreeWalker(r.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) if (r.intersectsNode(n)) nodes.push(n);
  if (r.commonAncestorContainer instanceof Text) nodes.push(r.commonAncestorContainer);
  for (const n of nodes) {
    const s = n === r.startContainer ? r.startOffset : 0;
    const e = n === r.endContainer ? r.endOffset : n.data.length;
    if (e <= s) continue;
    const piece = s > 0 ? n.splitText(s) : n;
    if (e - s < piece.data.length) piece.splitText(e - s);
    const span = document.createElement('span');
    span.dataset.mark = '1';
    span.style.backgroundColor = color;
    piece.parentNode!.insertBefore(span, piece);
    span.appendChild(piece);
  }
}

/** Draw `marks` over the blocks on the page now. */
export function setMarks(marks: PageMark[]) {
  current = marks;
  draw();
}

/** Draw the marks again (blocks were added to the page). */
export function draw() {
  const byColor = new Map<string, Range[]>();
  if (!nativeHighlights) unwrap();
  for (const m of current) {
    const block = document.querySelector<HTMLElement>(`[data-b="${m.b}"]`);
    if (!block || m.e <= m.s) continue;
    const r = rangeOf(block, m.s, m.e);
    if (nativeHighlights) byColor.set(m.color, [...(byColor.get(m.color) ?? []), r]);
    else wrap(r, m.color);
  }
  if (!nativeHighlights) return;
  registry!.clear();
  let css = '';
  [...byColor].forEach(([color, ranges], k) => {
    registry!.set(`m${k}`, new HighlightClass!(...ranges));
    css += `::highlight(m${k}){background-color:${color}}`;
  });
  style().textContent = css;
}
