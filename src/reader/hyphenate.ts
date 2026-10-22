// Hyphenation by inserting soft hyphens (U+00AD) at the break points the
// language's TeX patterns allow. Both iOS and Android only break a word at a
// soft hyphen (and then draw a hyphen there), so this gives the same result
// on both, in any language we have patterns for.

type Hyphenator = { hyphenateSync(text: string, options?: { hyphenChar?: string; minWordLength?: number }): string };

// Patterns are bundled but only evaluated when a book in that language is read,
// hence require() instead of imports.
/* eslint-disable @typescript-eslint/no-require-imports */
const LOADERS: Record<string, () => Hyphenator> = {
  en: () => require('hyphen/en-us'),
  ru: () => require('hyphen/ru'),
  uk: () => require('hyphen/uk'),
  be: () => require('hyphen/be'),
  bg: () => require('hyphen/bg'),
  de: () => require('hyphen/de-1996'),
  fr: () => require('hyphen/fr'),
  es: () => require('hyphen/es'),
  it: () => require('hyphen/it'),
  pt: () => require('hyphen/pt'),
  pl: () => require('hyphen/pl'),
  nl: () => require('hyphen/nl'),
  sv: () => require('hyphen/sv'),
  cs: () => require('hyphen/cs'),
  tr: () => require('hyphen/tr'),
};
/* eslint-enable @typescript-eslint/no-require-imports */
/** Languages without their own patterns that read well with a close relative's. */
const ALIASES: Record<string, string> = { az: 'tr', kk: 'ru', ky: 'ru', tt: 'ru', ba: 'ru', sk: 'cs' };
const CYRILLIC = new Set(['ru', 'uk', 'be', 'bg']);

const loaded = new Map<string, Hyphenator | null>();

function hyphenator(lang: string): Hyphenator | null {
  if (!loaded.has(lang)) {
    try {
      loaded.set(lang, LOADERS[lang]?.() ?? null);
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
 * Which patterns to use for a block: the book's language when it fits the
 * block's script, otherwise a guess from the script.
 */
export function pickLanguage(bookLang: string | undefined, text: string): string | null {
  const script = scriptOf(text);
  if (!script) return null;
  let lang = (bookLang ?? '').toLowerCase().split(/[-_]/)[0];
  lang = ALIASES[lang] ?? lang;
  if (LOADERS[lang] && CYRILLIC.has(lang) === (script === 'cyrillic')) return lang;
  return script === 'cyrillic' ? 'ru' : 'en';
}

/** Positions in `text` before which a soft hyphen may go (ascending). */
export function hyphenPoints(text: string, lang: string): number[] {
  const h = hyphenator(lang);
  if (!h) return [];
  let out: string;
  try {
    out = h.hyphenateSync(text, { hyphenChar: '­', minWordLength: 6 });
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
