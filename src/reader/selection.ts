// Text selected on the page, and the highlight tool's strokes, in book
// positions; kept free of React so it is tested on its own.

/** A point in the book: block and character offset in its text. */
export interface TextPoint {
  b: number;
  o: number;
}

/**
 * The highlight ranges for a finger dragged from `a` to `z` (either order,
 * possibly across paragraphs), widened to whole words at both ends. `textOf`
 * gives a block's text, or null for blocks that aren't text (images).
 */
export function dragRanges(a: TextPoint, z: TextPoint, textOf: (b: number) => string | null): { b: number; s: number; e: number }[] {
  const [from, to] = a.b < z.b || (a.b === z.b && a.o <= z.o) ? [a, z] : [z, a];
  const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
  const out: { b: number; s: number; e: number }[] = [];
  for (let b = from.b; b <= to.b; b++) {
    const text = textOf(b);
    if (!text) continue;
    let s = b === from.b ? Math.min(from.o, text.length) : 0;
    // `to.o` is the character under the finger, so the range ends after it.
    let e = b === to.b ? Math.min(to.o + 1, text.length) : text.length;
    // Ends inside a word take the whole word; ends on a space don't reach out.
    if (b === from.b && !isSpace(text[s])) while (s > 0 && !isSpace(text[s - 1])) s--;
    if (b === to.b && !isSpace(text[e - 1])) while (e < text.length && !isSpace(text[e])) e++;
    // Don't start or end on spaces.
    while (s < e && isSpace(text[s])) s++;
    while (e > s && isSpace(text[e - 1])) e--;
    if (e > s) out.push({ b, s, e });
  }
  return out;
}

/**
 * Text selected on the page: its first and last character (inclusive), in
 * reading order, possibly in different paragraphs; not necessarily whole
 * words (the browser's own selection).
 */
export interface TextSel {
  a: TextPoint;
  z: TextPoint;
}

type TextOf = (b: number) => string | null;

/** The selection between two points (either order), widened to whole words; null if only spaces. */
export function selectBetween(p: TextPoint, q: TextPoint, textOf: TextOf): TextSel | null {
  const r = dragRanges(p, q, textOf);
  if (!r.length) return null;
  const first = r[0];
  const last = r[r.length - 1];
  return { a: { b: first.b, o: first.s }, z: { b: last.b, o: last.e - 1 } };
}

/** The ranges a selection covers, one per paragraph. */
export function selectionRanges(sel: TextSel, textOf: TextOf): { b: number; s: number; e: number }[] {
  return dragRanges(sel.a, sel.z, textOf);
}

/** Whether block `b` goes on with the paragraph before it (a long paragraph is stored in parts: Block.c). */
type Continues = (b: number) => boolean;

/** The selected text widened to whole words, paragraphs on separate lines. */
export function selectionText(sel: TextSel, textOf: TextOf, continues?: Continues): string {
  const whole = selectBetween(sel.a, sel.z, textOf);
  return whole ? exactText(whole, textOf, continues) : '';
}

/**
 * Exactly the characters selected, from `a` to `z` (either order),
 * paragraphs on separate lines; the parts of a long paragraph run on.
 */
export function exactText(sel: TextSel, textOf: TextOf, continues?: Continues): string {
  const [from, to] = sel.a.b < sel.z.b || (sel.a.b === sel.z.b && sel.a.o <= sel.z.o) ? [sel.a, sel.z] : [sel.z, sel.a];
  let out = '';
  let any = false;
  for (let b = from.b; b <= to.b; b++) {
    const text = textOf(b);
    if (!text) continue;
    const s = b === from.b ? Math.min(from.o, text.length) : 0;
    // `z` is the last character selected.
    const e = b === to.b ? Math.min(to.o + 1, text.length) : text.length;
    if (e <= s) continue;
    if (any && !continues?.(b)) out += '\n';
    out += text.slice(s, e);
    any = true;
  }
  return out;
}
