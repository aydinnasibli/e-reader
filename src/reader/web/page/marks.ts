// Highlights and search hits as backgrounds behind text: spans with a
// background wrapped around it. (The CSS Custom Highlight API would leave the
// page as it is, but WebKit draws no highlights over text that can't be
// selected, and the book's text can't be: the page selects it itself,
// selection.ts.) The highlight tool's drag is drawn the same way, in spans of
// its own inside the marks' (over them), so moving it redraws only itself.

import type { PageMark } from '../protocol';
import { rangeIn } from './text';

let current: PageMark[] = [];
let stroke: PageMark[] = [];

/** Take the spans of one layer (`data-mark` or `data-stroke`) off the text. */
function unwrap(layer: 'mark' | 'stroke') {
  for (const span of [...document.querySelectorAll(`span[data-${layer}]`)]) {
    const parent = span.parentNode!;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  }
}

/** Wrap the text of a range in spans with a background, node by node. */
function wrap(r: Range, color: string, layer: 'mark' | 'stroke') {
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
    span.dataset[layer] = '1';
    span.style.backgroundColor = color;
    piece.parentNode!.insertBefore(span, piece);
    span.appendChild(piece);
  }
}

function wrapAll(marks: PageMark[], layer: 'mark' | 'stroke') {
  for (const m of marks) {
    const r = m.e > m.s ? rangeIn(document, m.b, m.s, m.e) : null;
    if (r) wrap(r, m.color, layer);
  }
}

/** Draw `marks` over the blocks on the page now. */
export function setMarks(marks: PageMark[]) {
  current = marks;
  draw();
}

/** The highlight tool's drag as it goes (none: it's over); the marks under it stay as they are. */
export function setStroke(marks: PageMark[]) {
  if (!marks.length && !stroke.length) return;
  stroke = marks;
  unwrap('stroke');
  wrapAll(stroke, 'stroke');
}

/** Draw the marks again (blocks were added to the page), the drag over them. */
export function draw() {
  unwrap('stroke');
  unwrap('mark');
  wrapAll(current, 'mark');
  wrapAll(stroke, 'stroke');
}
