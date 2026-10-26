// The little of a book's own CSS the reader honours: italic, bold, small
// capitals, centred or right-aligned text, and text hidden with display:none.
// Fonts, sizes, colours and margins stay the reader's settings. Selectors are
// matched as far as they're cheap to match while streaming: element names,
// classes, ids, and descendant/child combinations of those; anything else
// (attributes, pseudo-classes, siblings) is left out.

import { BOLD, ITALIC, SMALLCAPS } from './types';

/** What a rule or a style="" attribute says, in the terms the converter uses. */
export interface Declarations {
  /** Style bits turned on, and turned off (font-style:normal inside italics). */
  set: number;
  clear: number;
  /** text-align: centre, right, or left/justify (which undoes an inherited centre). */
  align?: 'c' | 'r' | 'l';
  /** display:none (true), or any other display, which undoes a display:none it overrides (false). */
  hidden?: boolean;
  /** list-style-type, for list numbering ('none', 'decimal', 'lower-alpha'...). */
  list?: string;
}

/** One element of a selector: `p.note.small`, `#x`, `*`. */
interface Compound {
  name?: string;
  id?: string;
  classes: string[];
}

interface Rule {
  /** Compounds from the element itself outward; combinators[i] joins parts[i] to parts[i + 1]. */
  parts: Compound[];
  child: boolean[];
  specificity: number;
  order: number;
  decl: Declarations;
}

interface Found {
  rule: Rule;
  sheet: number;
}

/** An element on the way down to the one being styled, for matching descendant selectors. */
export interface StyledElement {
  name: string;
  id?: string;
  classes: string[];
}

/**
 * What the open elements have, counted: a descendant selector whose
 * ancestors' classes, ids or names aren't there at all is passed over
 * without walking up the elements (books can leave hundreds unclosed).
 */
export class PathIndex {
  private classes = new Map<string, number>();
  private ids = new Map<string, number>();
  private names = new Map<string, number>();

  /** Count an element entering (1) or leaving (-1) the open elements. */
  add(e: StyledElement, d: 1 | -1) {
    for (let i = 0; i < e.classes.length; i++) bump(this.classes, e.classes[i], d);
    if (e.id) bump(this.ids, e.id, d);
    if (e.name) bump(this.names, e.name, d);
  }

  /** Some open element could match `c`. */
  mayHave(c: Compound): boolean {
    if (c.classes.length) return !!this.classes.get(c.classes[0]);
    if (c.id) return !!this.ids.get(c.id);
    return !c.name || !!this.names.get(c.name);
  }
}

function bump(map: Map<string, number>, key: string, d: number) {
  const n = (map.get(key) ?? 0) + d;
  if (n > 0) map.set(key, n);
  else map.delete(key);
}

/** How far up a descendant selector looks for its ancestors. */
const MAX_DEPTH = 64;

export const EMPTY: Declarations = { set: 0, clear: 0 };

function hasEffect(d: Declarations) {
  return d.set || d.clear || d.align || d.hidden !== undefined || d.list;
}

/** Parse declarations ("font-style: italic; text-align: center"), keeping the ones that matter. */
export function parseDeclarations(text: string): Declarations {
  const d: Declarations = { set: 0, clear: 0 };
  for (const part of text.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    const value = part
      .slice(colon + 1)
      .replace(/!\s*important/i, '')
      .trim()
      .toLowerCase();
    switch (prop) {
      case 'font-style':
        if (value === 'italic' || value.startsWith('oblique')) {
          d.set |= ITALIC;
          d.clear &= ~ITALIC;
        } else if (value === 'normal') {
          d.clear |= ITALIC;
          d.set &= ~ITALIC;
        }
        break;
      case 'font-weight': {
        const n = value === 'bold' || value === 'bolder' ? 700 : value === 'normal' || value === 'lighter' ? 400 : Number(value);
        if (n >= 600) {
          d.set |= BOLD;
          d.clear &= ~BOLD;
        } else if (n > 0) {
          d.clear |= BOLD;
          d.set &= ~BOLD;
        }
        break;
      }
      case 'font-variant':
      case 'font-variant-caps':
        if (value.includes('small-caps')) {
          d.set |= SMALLCAPS;
          d.clear &= ~SMALLCAPS;
        } else if (value === 'normal' || value === 'none') {
          d.clear |= SMALLCAPS;
          d.set &= ~SMALLCAPS;
        }
        break;
      case 'font': {
        // The shorthand: "italic bold 1em/1.2 Georgia", "small-caps 90% serif". What
        // it leaves out is reset to normal: "font: 1em serif" inside italics is upright.
        if (value === 'inherit' || value === 'initial' || value === 'unset') break;
        let bits = 0;
        for (const word of value.split(/\s+/)) {
          if (word === 'italic' || word === 'oblique') bits |= ITALIC;
          else if (word === 'bold' || word === 'bolder' || /^[6-9]00$/.test(word)) bits |= BOLD;
          else if (word === 'small-caps') bits |= SMALLCAPS;
        }
        d.set = (d.set & ~(ITALIC | BOLD | SMALLCAPS)) | bits;
        d.clear = (d.clear & ~bits) | (~bits & (ITALIC | BOLD | SMALLCAPS));
        break;
      }
      case 'text-align':
        // (inherit, unset and match-parent keep what the block inherits.)
        if (value === 'center' || value === '-webkit-center') d.align = 'c';
        else if (value === 'right' || value === 'end') d.align = 'r';
        else if (value === 'left' || value === 'start' || value === 'justify' || value === 'initial') d.align = 'l';
        break;
      case 'display':
        if (value !== 'inherit' && value !== 'initial' && value !== 'unset') d.hidden = value === 'none';
        break;
      case 'list-style-type':
      case 'list-style':
        for (const word of value.split(/\s+/)) {
          if (/^(none|disc|circle|square|decimal|decimal-leading-zero|lower-alpha|upper-alpha|lower-latin|upper-latin|lower-roman|upper-roman)$/.test(word)) d.list = word;
        }
        break;
    }
  }
  return d;
}

/** Merge `d` over `base` (later wins). */
function merge(base: Declarations, d: Declarations): Declarations {
  return {
    set: (base.set & ~d.clear) | d.set,
    clear: (base.clear & ~d.set) | d.clear,
    align: d.align ?? base.align,
    hidden: d.hidden ?? base.hidden,
    list: d.list ?? base.list,
  };
}

/** Parse one compound selector; null if it uses anything we don't match. */
function compound(text: string): Compound | null {
  const m = /^(\*|[a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/.exec(text);
  if (!m) return null;
  const c: Compound = { classes: [] };
  if (m[1] && m[1] !== '*') c.name = m[1].toLowerCase();
  for (const piece of m[2].match(/[.#][\w-]+/g) ?? []) {
    if (piece[0] === '.') c.classes.push(piece.slice(1));
    else c.id = piece.slice(1);
  }
  return c;
}

function parseSelector(text: string): { parts: Compound[]; child: boolean[]; specificity: number } | null {
  const tokens = text
    .trim()
    .replace(/\s*>\s*/g, ' > ')
    .split(/\s+/);
  const parts: Compound[] = [];
  const child: boolean[] = [];
  let pendingChild = false;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t === '>') {
      if (!parts.length || pendingChild) return null;
      pendingChild = true;
      continue;
    }
    const c = compound(t);
    if (!c) return null;
    if (parts.length) child.push(pendingChild);
    pendingChild = false;
    parts.push(c);
  }
  if (!parts.length || pendingChild) return null;
  let specificity = 0;
  for (const p of parts) specificity += (p.id ? 10000 : 0) + p.classes.length * 100 + (p.name ? 1 : 0);
  return { parts, child, specificity };
}

function matches(c: Compound, e: StyledElement): boolean {
  if (c.name && c.name !== e.name) return false;
  if (c.id && c.id !== e.id) return false;
  for (const cls of c.classes) if (!e.classes.includes(cls)) return false;
  return true;
}

/** Rules from one or more style sheets, indexed by what the element itself must have. */
export class StyleSheet {
  private byClass = new Map<string, Rule[]>();
  private byId = new Map<string, Rule[]>();
  private byName = new Map<string, Rule[]>();
  private any: Rule[] = [];
  private count = 0;

  get empty() {
    return this.count === 0;
  }

  /** Add the rules of a style sheet; later ones win over earlier ones of the same specificity. */
  add(css: string) {
    const text = css.replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ');
    const len = text.length;
    let i = 0;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c <= 32 || c === 125 /* } */ || c === 59 /* ; */) {
        i++;
        continue;
      }
      const brace = text.indexOf('{', i);
      if (c === 64 /* @ */) {
        // At-rules are skipped whole: media queries (often for other devices), fonts, pages, imports.
        const semi = text.indexOf(';', i);
        if (brace < 0 || (semi >= 0 && semi < brace)) {
          i = semi < 0 ? len : semi + 1;
          continue;
        }
        let depth = 0;
        let j = brace;
        for (; j < len; j++) {
          const d = text.charCodeAt(j);
          if (d === 123) depth++;
          else if (d === 125 && --depth === 0) break;
        }
        i = j + 1;
        continue;
      }
      if (brace < 0) break;
      const close = text.indexOf('}', brace);
      const head = text.slice(i, brace);
      const decl = parseDeclarations(text.slice(brace + 1, close < 0 ? len : close));
      i = close < 0 ? len : close + 1;
      if (!hasEffect(decl)) continue;
      for (const sel of head.split(',')) {
        const parsed = parseSelector(sel);
        if (!parsed) continue;
        const rule: Rule = { ...parsed, order: this.count++, decl };
        const self = parsed.parts[0];
        if (self.classes.length) this.index(this.byClass, self.classes[0], rule);
        else if (self.id) this.index(this.byId, self.id, rule);
        else if (self.name) this.index(this.byName, self.name, rule);
        else this.any.push(rule);
      }
    }
  }

  private index(map: Map<string, Rule[]>, key: string, rule: Rule) {
    const list = map.get(key);
    if (list) list.push(rule);
    else map.set(key, [rule]);
  }

  /**
   * The rules that apply to element `e` (its ancestors in `path`, outermost
   * first, counted in `index`), added to `out`.
   */
  collect(e: StyledElement, path: StyledElement[], sheet: number, out: Found[], index?: PathIndex) {
    if (!this.count) return;
    for (let i = 0; i < e.classes.length; i++) this.consider(this.byClass.get(e.classes[i]), e, path, sheet, out, index);
    if (e.id) this.consider(this.byId.get(e.id), e, path, sheet, out, index);
    this.consider(this.byName.get(e.name), e, path, sheet, out, index);
    if (this.any.length) this.consider(this.any, e, path, sheet, out, index);
  }

  private consider(list: Rule[] | undefined, e: StyledElement, path: StyledElement[], sheet: number, out: Found[], index?: PathIndex) {
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const rule = list[i];
      if (!this.applies(rule, e, path, index)) continue;
      let seen = false;
      for (let k = 0; k < out.length && !seen; k++) seen = out[k].rule === rule;
      if (!seen) out.push({ rule, sheet });
    }
  }

  private applies(r: Rule, e: StyledElement, path: StyledElement[], index?: PathIndex): boolean {
    if (!matches(r.parts[0], e)) return false;
    if (r.parts.length === 1) return true;
    if (index) for (let p = 1; p < r.parts.length; p++) if (!index.mayHave(r.parts[p])) return false;
    // Walk outward through the ancestors for the rest of the selector, not past MAX_DEPTH of them.
    const stop = Math.max(-1, path.length - 1 - MAX_DEPTH);
    let at = path.length - 1;
    for (let p = 1; p < r.parts.length; p++) {
      const child = r.child[p - 1];
      if (child) {
        if (at <= stop || !matches(r.parts[p], path[at])) return false;
        at--;
      } else {
        while (at > stop && !matches(r.parts[p], path[at])) at--;
        if (at <= stop) return false;
        at--;
      }
    }
    return true;
  }
}

/**
 * What a chapter's style sheets (in the order they apply) and the element's
 * own style="" say about element `e`: the most specific rule wins, the later
 * one between equals, and style="" over all of them.
 */
export function styleOf(sheets: StyleSheet[], e: StyledElement, path: StyledElement[], inline: string | undefined, index?: PathIndex): Declarations {
  let d = EMPTY;
  if (sheets.length) {
    const found: Found[] = [];
    for (let i = 0; i < sheets.length; i++) sheets[i].collect(e, path, i, found, index);
    if (found.length > 1) found.sort((a, b) => a.rule.specificity - b.rule.specificity || a.sheet - b.sheet || a.rule.order - b.rule.order);
    for (let i = 0; i < found.length; i++) d = merge(d, found[i].rule.decl);
  }
  return inline ? merge(d, parseDeclarations(inline)) : d;
}
