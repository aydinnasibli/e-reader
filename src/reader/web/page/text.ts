// Drawn points <-> places in the page's DOM. Every block element carries
// data-b (its index in the book) and its text is exactly the block's drawn
// text, so a drawn offset is the number of UTF-16 code units of text before a
// place inside it. The browser does the rest: it knows where every letter is.

import type { DrawnPoint, PageCaret } from '../protocol';

export function blockOf(n: Node | null): HTMLElement | null {
  const el = n instanceof Element ? n : (n?.parentElement ?? null);
  return (el?.closest('[data-b]') as HTMLElement | null) ?? null;
}

/** The drawn point at a DOM place (a node and an offset in it, as ranges and selections give them). */
export function pointOf(node: Node, offset: number): DrawnPoint | null {
  const block = blockOf(node);
  if (!block) return null;
  const b = Number(block.dataset.b);
  const r = document.createRange();
  r.selectNodeContents(block);
  try {
    r.setEnd(node, offset);
  } catch {
    return { b, i: 0 };
  }
  return { b, i: r.toString().length };
}

/** The DOM place of drawn offset `i` in a block. */
export function placeAt(block: HTMLElement, i: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let left = Math.max(0, i);
  let last: Text | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (left < n.data.length) return { node: n, offset: left };
    left -= n.data.length;
    last = n;
  }
  return last ? { node: last, offset: last.data.length } : { node: block, offset: 0 };
}

/** A range over drawn offsets [s, e) of a block. */
export function rangeOf(block: HTMLElement, s: number, e: number): Range {
  const r = document.createRange();
  const a = placeAt(block, s);
  const z = placeAt(block, Math.max(s, e));
  r.setStart(a.node, a.offset);
  r.setEnd(z.node, z.offset);
  return r;
}

/** Text length of a block's drawn text. */
export const lengthOf = (block: HTMLElement) => block.textContent?.length ?? 0;

/** The first visible box of a range (soft hyphens and line ends can give empty ones). */
function boxes(r: Range): DOMRect[] {
  return [...r.getClientRects()].filter((x) => x.height > 0);
}

/** Where drawn character `i` of a block is drawn; null if nowhere (an invisible soft hyphen). */
export function charBox(block: HTMLElement, i: number): DOMRect | null {
  return boxes(rangeOf(block, i, i + 1))[0] ?? null;
}

/** Carets at both ends of a range, in WebView points. */
export function carets(r: Range): { start: PageCaret; end: PageCaret } | null {
  const bs = boxes(r);
  if (!bs.length) return null;
  const a = bs[0];
  const z = bs[bs.length - 1];
  return { start: { x: a.left, y: a.top, h: a.height }, end: { x: z.right, y: z.top, h: z.height } };
}

/** The drawn point under a point on screen: the nearest place in text. */
export function pointAtScreen(x: number, y: number): DrawnPoint | null {
  const doc = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null };
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    return r ? pointOf(r.startContainer, r.startOffset) : null;
  }
  const p = doc.caretPositionFromPoint?.(x, y);
  return p ? pointOf(p.offsetNode, p.offset) : null;
}

/** All block elements inside `root`, in reading order. */
export const blocksIn = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('[data-b]')];
