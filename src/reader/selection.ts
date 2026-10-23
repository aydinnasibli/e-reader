// Word selection in the selection sheet, kept free of React so it is tested
// on its own.

export interface Token {
  text: string;
  start: number;
  word: boolean;
}

/**
 * Words are runs between spaces, except in Chinese and Japanese, which don't
 * put spaces between words: there each character is a word of its own, so a
 * long press selects one character (and its dictionary entry) rather than the
 * whole sentence.
 */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  // CJK punctuation and full-width forms (。、！) stand alone too.
  const re = /\s+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]+/gu;
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

/**
 * Text selected on the page: its first and last character (inclusive), in
 * reading order, possibly in different paragraphs. Always whole words.
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

/** The selected text, paragraphs on separate lines. */
export function selectionText(sel: TextSel, textOf: TextOf): string {
  return selectionRanges(sel, textOf)
    .map((r) => textOf(r.b)!.slice(r.s, r.e))
    .join('\n');
}
