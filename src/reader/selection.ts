// Word selection in the selection sheet, kept free of React so it is tested
// on its own.

export interface Token {
  text: string;
  start: number;
  word: boolean;
}

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /\s+|[^\s]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ text: m[0], start: m.index, word: !/^\s/.test(m[0]) });
  return out;
}

/** The word token at (or nearest to) character `at`, or -1 if there are no words. */
export function wordAt(tokens: Token[], at: number): number {
  let best = -1;
  let dist = Infinity;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.word) continue;
    const d = at < t.start ? t.start - at : at >= t.start + t.text.length ? at - (t.start + t.text.length) + 1 : 0;
    if (d < dist) {
      best = i;
      dist = d;
    }
    if (d === 0) break;
  }
  return best;
}

export interface Sel {
  a: number;
  z: number;
}

/** Tapping word `i`: outside the selection extends it; inside starts over from that word. */
export function tapWord(sel: Sel | null, i: number): Sel {
  if (!sel || (i >= sel.a && i <= sel.z)) return { a: i, z: i };
  return { a: Math.min(sel.a, i), z: Math.max(sel.z, i) };
}

/** Word tokens covering the character range [s, e). */
export function tokensFor(tokens: Token[], s: number, e: number): Sel | null {
  let a = -1;
  let z = -1;
  tokens.forEach((t, i) => {
    if (t.word && t.start < e && s < t.start + t.text.length) {
      if (a < 0) a = i;
      z = i;
    }
  });
  return a < 0 ? null : { a, z };
}

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
