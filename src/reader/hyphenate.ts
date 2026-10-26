// Hyphenation by inserting soft hyphens (U+00AD) at the break points the
// language's TeX patterns allow. Both iOS and Android only break a word at a
// soft hyphen (and then draw a hyphen there), so this gives the same result
// on both, in any language we have patterns for.

import { guessLanguage, normaliseLanguage } from '@/engine/language';

/** Text with soft hyphens put in. */
type Hyphenator = (text: string) => string;
type Options = { hyphenChar: string; minWordLength: number; html: boolean };

// Patterns are bundled but only evaluated when a book in that language is read,
// hence require() instead of imports.
/* eslint-disable @typescript-eslint/no-require-imports */
const create = (): ((patterns: unknown, options: Options) => Hyphenator) => require('hyphen/hyphen');
const LOADERS: Record<string, () => unknown> = {
  en: () => require('hyphen/patterns/en-us'),
  ru: () => require('hyphen/patterns/ru'),
  uk: () => require('hyphen/patterns/uk'),
  be: () => require('hyphen/patterns/be'),
  bg: () => require('hyphen/patterns/bg'),
  de: () => require('hyphen/patterns/de-1996'),
  fr: () => require('hyphen/patterns/fr'),
  es: () => require('hyphen/patterns/es'),
  it: () => require('hyphen/patterns/it'),
  pt: () => require('hyphen/patterns/pt'),
  pl: () => require('hyphen/patterns/pl'),
  nl: () => require('hyphen/patterns/nl'),
  sv: () => require('hyphen/patterns/sv'),
  cs: () => require('hyphen/patterns/cs'),
  tr: () => require('hyphen/patterns/tr'),
};
/* eslint-enable @typescript-eslint/no-require-imports */
/** Languages without their own patterns that read well with a close relative's. */
const ALIASES: Record<string, string> = { az: 'tr', kk: 'ru', ky: 'ru', tt: 'ru', ba: 'ru', sk: 'cs' };
const CYRILLIC = new Set(['ru', 'uk', 'be', 'bg']);

const loaded = new Map<string, Hyphenator | null>();

function hyphenator(lang: string): Hyphenator | null {
  if (!loaded.has(lang)) {
    try {
      const patterns = LOADERS[lang]?.();
      // `html: false`: a "<" in the text is text, not the start of a tag to skip (the
      // package reads this only when a hyphenator is made, not per call).
      loaded.set(lang, patterns ? create()(patterns, { hyphenChar: '\u00ad', minWordLength: 6, html: false }) : null);
    } catch {
      loaded.set(lang, null);
    }
  }
  return loaded.get(lang) ?? null;
}

function scriptOf(text: string): 'cyrillic' | 'latin' | null {
  let cyr = 0;
  let lat = 0;
  for (let i = 0; i < text.length && i < 400; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x400 && c <= 0x4ff) cyr++;
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 0xc0 && c <= 0x24f)) lat++;
  }
  if (!cyr && !lat) return null;
  return cyr > lat ? 'cyrillic' : 'latin';
}

/**
 * Which patterns to use for a block: the book's language ('tr', 'tr-TR',
 * 'tur', 'Turkish') when it fits the block's script; for a book that doesn't
 * say, the language of the block's text when it can be told; otherwise a
 * guess from the script.
 */
export function pickLanguage(bookLang: string | undefined, text: string): string | null {
  const script = scriptOf(text);
  if (!script) return null;
  let lang = normaliseLanguage(bookLang) ?? guessLanguage(text) ?? '';
  lang = ALIASES[lang] ?? lang;
  if (LOADERS[lang] && CYRILLIC.has(lang) === (script === 'cyrillic')) return lang;
  return script === 'cyrillic' ? 'ru' : 'en';
}

/** Languages whose dotless I and dotted İ are separate letters (I is the capital of ı, İ of i). */
const TURKIC = new Set(['tr', 'az']);

/**
 * The text in lower case, letter for letter (the same length): the patterns
 * are matched in lower case, and lowercasing it whole would turn İ into two
 * characters (i and a dot) outside a Turkish phone and shift every break
 * after it ("İst-anb-ul"). Turkish I is lowercased to ı.
 */
function lowerLetters(text: string, lang: string): string {
  const turkic = TURKIC.has(lang);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === 'İ') out += 'i';
    else if (c === 'I' && turkic) out += 'ı';
    else {
      const l = c.toLowerCase();
      out += l.length === 1 ? l : c;
    }
  }
  return out;
}

/** Positions in `text` before which a soft hyphen may go (ascending). */
export function hyphenPoints(text: string, lang: string): number[] {
  const h = hyphenator(lang);
  if (!h) return [];
  let out: string;
  try {
    out = h(lowerLetters(text, lang));
  } catch {
    return [];
  }
  const points: number[] = [];
  let o = 0;
  for (let i = 0; i < out.length; i++) {
    if (out.charCodeAt(i) === 0xad) points.push(o);
    else o++;
  }
  return points;
}
