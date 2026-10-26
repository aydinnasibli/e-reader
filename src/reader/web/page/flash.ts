// After the layout changed (text size, font, spacing, the mode, the phone
// turned), the line read is marked for a moment: pages are always cut the
// same way, so the page shown holds the place but needn't start with it. A
// tint over the line, out of the text's way: drawn over it in a layer of its
// own, not taking part in the layout, not to be touched or selected.

import type { DrawnPoint } from '../protocol';
import { charBox, lengthOf, partAt } from './text';

const SHOWN_MS = 1400;
const FADE_MS = 600;

let shown: HTMLElement | null = null;
let timers: ReturnType<typeof setTimeout>[] = [];

/** The mark taken off at once (a page turned, laid out again). */
export function clearFlash() {
  for (const t of timers) clearTimeout(t);
  timers = [];
  shown?.remove();
  shown = null;
}

/** Mark the line drawn point `p` is on, in `layer` (positioned: page mode's viewport, scroll mode's page). */
export function flashLine(root: ParentNode, p: DrawnPoint, layer: HTMLElement) {
  clearFlash();
  const part = partAt(root, p.b, p.i);
  if (!part) return;
  const { el } = part;
  const len = lengthOf(el);
  let box: DOMRect | null = null;
  for (let i = Math.min(part.i, Math.max(0, len - 1)); !box && i < len; i++) box = charBox(el, i);
  const block = el.parentElement?.hasAttribute('data-w') ? el.parentElement : el;
  // The line across its column: the block's piece holding the character (a block can run over pages).
  const pieces = [...block.getClientRects()];
  const at = box ?? pieces[0];
  if (!at) return;
  const piece = pieces.find((q) => q.left <= at.left + 1 && q.right >= at.right - 1) ?? at;
  const lh = parseFloat(getComputedStyle(block).lineHeight) || at.height;
  const middle = at.top + at.height / 2;
  const origin = layer.getBoundingClientRect();
  const mark = document.createElement('div');
  mark.className = 'flash';
  mark.style.cssText = `left:${piece.left - origin.left}px;top:${middle - lh / 2 - origin.top}px;width:${piece.width}px;height:${lh}px`;
  layer.appendChild(mark);
  shown = mark;
  timers = [
    setTimeout(() => mark.classList.add('out'), SHOWN_MS),
    setTimeout(() => {
      if (shown === mark) clearFlash();
    }, SHOWN_MS + FADE_MS),
  ];
}
