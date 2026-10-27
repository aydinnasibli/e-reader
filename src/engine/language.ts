// A book's language as a two-letter code ('en', 'tr'): what hyphenation,
// look-up and the page's Turkish typography go by. Books name it in many
// ways ('tr-TR', 'tur', 'Turkish'), and TXT files not at all, so it is also
// guessed from the text.

/**
 * Three-letter (ISO 639-2) codes of the languages the app is likely to meet.
 * (This and NAMES are Maps: the keys come from books, and a language called
 * "constructor" is no language, not something every object has.)
 */
const THREE = new Map(Object.entries({
  eng: 'en',
  tur: 'tr',
  aze: 'az',
  rus: 'ru',
  ukr: 'uk',
  bel: 'be',
  bul: 'bg',
  kaz: 'kk',
  uzb: 'uz',
  deu: 'de',
  ger: 'de',
  fra: 'fr',
  fre: 'fr',
  spa: 'es',
  ita: 'it',
  por: 'pt',
  pol: 'pl',
  nld: 'nl',
  dut: 'nl',
  swe: 'sv',
  ces: 'cs',
  cze: 'cs',
  slk: 'sk',
  slo: 'sk',
  ell: 'el',
  gre: 'el',
  ara: 'ar',
  fas: 'fa',
  per: 'fa',
  heb: 'he',
  zho: 'zh',
  chi: 'zh',
  jpn: 'ja',
  kor: 'ko',
}));

/** Language names, in English and in the language itself. */
const NAMES = new Map(Object.entries({
  english: 'en',
  turkish: 'tr',
  türkçe: 'tr',
  turkce: 'tr',
  azerbaijani: 'az',
  azərbaycan: 'az',
  russian: 'ru',
  русский: 'ru',
  ukrainian: 'uk',
  українська: 'uk',
  german: 'de',
  deutsch: 'de',
  french: 'fr',
  français: 'fr',
  spanish: 'es',
  español: 'es',
  italian: 'it',
  italiano: 'it',
  portuguese: 'pt',
  português: 'pt',
  polish: 'pl',
  polski: 'pl',
  dutch: 'nl',
  nederlands: 'nl',
}));

/**
 * The two-letter code for a language tag or name ('tr-TR', 'tur',
 * 'Turkish', 'TR' → 'tr'), or undefined if it isn't one.
 */
export function normaliseLanguage(tag?: string | null): string | undefined {
  const t = tag?.trim().toLowerCase();
  if (!t) return undefined;
  const head = t.split(/[-_\s]/)[0];
  if (/^[a-z]{2}$/.test(head)) return head;
  return THREE.get(head) ?? NAMES.get(head) ?? NAMES.get(t);
}

/** Common short words, which make up a large share of any running text. */
const WORDS: Record<string, Set<string>> = {
  en: new Set('the and of to a in is that it was he for with as his on be at by i you her she had not but'.split(' ')),
  // With the spellings of text typed without Turkish letters (icin, cok).
  tr: new Set('ve bir bu da de ne için ile ama çok gibi daha o ben sen ki mi diye kadar her şey değil icin cok sey degil'.split(' ')),
  az: new Set('və bir bu da də nə üçün ilə amma çox kimi daha o mən sən ki hər şey deyil'.split(' ')),
  de: new Set('der die und in den von zu das mit sich des auf für ist im nicht ein eine als auch es'.split(' ')),
  fr: new Set('de la le et les des en un une du est que pour dans qui pas au il elle ne'.split(' ')),
  es: new Set('de la que el en y los del se las por un una para con no es al lo como'.split(' ')),
  it: new Set('di che il la per un non in una sono mi ho lo ma ha le si gli con del'.split(' ')),
  pt: new Set('de que não o a do da em um para é com uma os no se na por mais as dos'.split(' ')),
  ru: new Set('и в не на я что он с как а то это по но она к у из за так же от'.split(' ')),
  uk: new Set('і в не на що я він з як а та це по але вона до у із за так же від'.split(' ')),
};

// Letters of the alphabets WORDS uses (Latin, Greek, Cyrillic), as runs: a book's words.
// (Regexes rather than loops over characters: this looks at up to 50 KB, and Hermes has no JIT.)
const WORD = /[a-z'\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u024f\u0370-\u03ff\u0400-\u052f]+/g;

/** The sample's words, in lower case. */
function wordsOf(sample: string): string[] {
  return sample.toLowerCase().match(WORD) ?? [];
}

/** How many characters of `sample` are in a set, given as a regex of everything outside it. */
const countOf = (sample: string, notCls: RegExp) => sample.replace(notCls, '').length;

/**
 * The language of a sample of a book's text, from its letters and its most
 * common words; undefined when the sample is too short or unclear. Only
 * tells apart the languages in WORDS. `clear`: only a guess the text leaves
 * no doubt about (twice the evidence), e.g. to overrule a book's metadata.
 */
export function guessLanguage(sample: string, clear = false): string | undefined {
  const latin = countOf(sample, /[^A-Za-z\u00c0-\u024f]+/g);
  const cyrillic = countOf(sample, /[^\u0400-\u04ff]+/g);
  if (latin + cyrillic < 200) return undefined;
  // Letters only Turkish (and Azerbaijani) use among Latin alphabets: ı İ ğ Ğ ş Ş.
  const turkic = countOf(sample, /[^ıİğĞşŞ]+/g);
  // ə: Azerbaijani, not Turkish.
  const schwa = countOf(sample, /[^əƏ]+/g);
  const k = clear ? 2 : 1;
  // Turkish prose has ı ğ ş in about one letter in twelve; an English book
  // that names a few Turkish places, far fewer. Below this the words decide.
  if (latin > cyrillic && turkic > latin * 0.02 * k) return schwa > latin * 0.004 ? 'az' : 'tr';
  const words = wordsOf(sample);
  if (words.length < 40) return undefined;
  let best: string | undefined;
  let bestShare = 0;
  let second = 0;
  for (const [lang, set] of Object.entries(WORDS)) {
    if ((lang === 'ru' || lang === 'uk') !== cyrillic > latin) continue;
    let n = 0;
    for (const w of words) if (set.has(w)) n++;
    const share = n / words.length;
    if (share > bestShare) {
      second = bestShare;
      bestShare = share;
      best = lang;
    } else if (share > second) second = share;
  }
  // Running text in any of these languages is a fifth or more common words.
  if (clear && bestShare < second * 1.5) return undefined;
  return bestShare >= 0.12 * (clear ? 1.5 : 1) ? best : undefined;
}

/**
 * A book's language: what its metadata says (normalised), unless its text
 * clearly says otherwise (tools often stamp every book "en"); guessed from
 * the text when the metadata says nothing.
 */
export function bookLanguage(declared: string | null | undefined, sample: string): string | undefined {
  const named = normaliseLanguage(declared);
  const clear = guessLanguage(sample, true);
  if (clear && clear !== named) return clear;
  return named ?? guessLanguage(sample);
}
