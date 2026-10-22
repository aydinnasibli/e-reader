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
