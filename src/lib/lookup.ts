// Definitions and translations shown inside the app. No keys: definitions come
// from Wiktionary (every language, explained in English), with Google's
// dictionary as a fallback; Turkish words also from the Turkish Language
// Association's dictionary (TDK), in Turkish, with the English meaning under
// it. Translations come from Google Translate, with MyMemory as a fallback.

import { fold } from '@/engine/fold';
import { normaliseLanguage } from '@/engine/language';

export interface Sense {
  /** Part of speech: "Noun", "Verb", ... */
  pos: string;
  defs: { text: string; example?: string }[];
}

export interface Definition {
  word: string;
  /** Language the entry is for, e.g. "English". */
  language?: string;
  senses: Sense[];
  source: 'Wiktionary' | 'Google' | 'TDK';
  /** Under a Turkish definition: what the word means in English. */
  english?: Definition;
  /** Google's short translation of the very word selected ("evlerinden": "from their homes"). */
  gloss?: string;
}

export interface Translation {
  text: string;
  /** Detected source language code. */
  from?: string;
  /** Only the beginning of a long selection was translated. */
  partial?: boolean;
  /** The service that translated it, credited under the translation. */
  source: 'Google Translate' | 'MyMemory';
}

/** Languages offered as translation targets. */
export const LANGUAGES: { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'az', name: 'Azərbaycan' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'ru', name: 'Русский' },
  { code: 'uk', name: 'Українська' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'es', name: 'Español' },
  { code: 'it', name: 'Italiano' },
  { code: 'pt', name: 'Português' },
  { code: 'pl', name: 'Polski' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'ka', name: 'ქართული' },
  { code: 'kk', name: 'Қазақ' },
  { code: 'uz', name: 'Oʻzbek' },
  { code: 'fa', name: 'فارسی' },
  { code: 'ar', name: 'العربية' },
  { code: 'zh-CN', name: '中文' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
];

/**
 * The language to translate a book's text into: the one chosen for books in
 * its language (`chosen`, '' for books whose language isn't known); else the
 * one chosen by older versions for all books, the phone's, English or
 * Turkish, whichever isn't the book's own (Turkish into Turkish says nothing).
 */
export function translateTarget(bookLang: string | undefined, chosen: Record<string, string>, legacy: string, phone: string): string {
  const from = normaliseLanguage(bookLang) ?? '';
  if (chosen[from]) return chosen[from];
  const target = [legacy, phone, 'en', 'tr'].find((c) => c && normaliseLanguage(c) !== from);
  return LANGUAGES.find((l) => l.code === target || l.code.slice(0, 2) === target)?.code ?? target ?? 'en';
}

export function languageName(code?: string): string | undefined {
  if (!code) return undefined;
  const c = code.toLowerCase();
  return LANGUAGES.find((l) => l.code.toLowerCase() === c || l.code.slice(0, 2) === c.slice(0, 2))?.name;
}

const TIMEOUT_MS = 12000;

/**
 * Who is asking, sent to Wikimedia and TDK. Wikimedia refuses requests
 * without a real User-Agent ("Please set a user-agent", 403), and an Android
 * app's requests otherwise go out as "okhttp/…"; the Api-User-Agent header
 * alone isn't taken instead.
 */
export const USER_AGENT = 'NecReader/1.0 (https://github.com/aydinnasibli/e-reader; personal e-book reader)';
const IDENTIFIED = { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT };

/** Thrown when there is no connection (`offline`) or the service didn't answer properly. */
export class LookupError extends Error {
  constructor(
    message: string,
    readonly offline = false,
  ) {
    super(message);
  }
}

async function getJson(url: string, headers?: Record<string, string>, signal?: AbortSignal, timeout = TIMEOUT_MS): Promise<unknown | null> {
  // The card was closed: nothing more is sent (a listener added now would never hear of it).
  if (signal?.aborted) throw new LookupError('Cancelled');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new LookupError(`HTTP ${res.status}`);
    const body = await res.text();
    try {
      return JSON.parse(body);
    } catch {
      // A sign-in or "unusual traffic" page instead of an answer.
      throw new LookupError('Not JSON');
    }
  } catch (e) {
    if (e instanceof LookupError) throw e;
    // fetch itself failed: no connection, or it took too long.
    throw new LookupError(String(e), true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** The word to look up from a selection: composed, no punctuation around it (a final accent stays: "kuş" written decomposed). */
export function cleanWord(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\u00AD\u200B]/g, '')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A word in lower case as its language writes it: Turkish (and Azerbaijani)
 * I is ı and İ is i ("Işık" → "ışık", "İnsan" → "insan"; JavaScript's own
 * lower case gives "işık" and "i̇nsan", which no dictionary has).
 */
export function lowerWord(word: string, lang?: string): string {
  const turkic = lang === 'tr' || lang === 'az';
  return (turkic ? word.replace(/I/g, 'ı') : word).replace(/İ/g, 'i').toLowerCase();
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

/** Wiktionary returns small bits of HTML; keep only the text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (ENTITIES[e]) return ENTITIES[e];
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

interface WikiSense {
  partOfSpeech?: string;
  language?: string;
  definitions?: {
    definition?: string;
    examples?: string[];
    parsedExamples?: { example?: string }[];
  }[];
}

/**
 * Read Wiktionary's answer, preferring the entry in the book's language, then
 * English. `only`: that language's entry or nothing.
 */
export function parseWiktionary(word: string, json: unknown, lang?: string, only = false): Definition | null {
  if (!json || typeof json !== 'object') return null;
  const byLang = json as Record<string, WikiSense[]>;
  const codes = Object.keys(byLang).filter((k) => Array.isArray(byLang[k]));
  const want = normaliseLanguage(lang);
  const code = (want && codes.find((c) => c === want)) || (only ? undefined : codes.find((c) => c === 'en') || codes[0]);
  if (!code) return null;
  const senses: Sense[] = [];
  for (const s of byLang[code]) {
    const defs = (s.definitions ?? [])
      .map((d) => {
        const text = stripHtml(d.definition ?? '');
        const ex = d.parsedExamples?.[0]?.example ?? d.examples?.[0];
        return { text, example: ex ? stripHtml(ex) : undefined };
      })
      .filter((d) => d.text);
    if (defs.length) senses.push({ pos: s.partOfSpeech ?? '', defs: defs.slice(0, 6) });
  }
  if (!senses.length) return null;
  return {
    word,
    language: byLang[code][0]?.language,
    senses,
    source: 'Wiktionary',
  };
}

/**
 * Google's dictionary (dt=md with dj=1, named fields):
 * { definitions: [{ pos, entry: [{ gloss, example? }], base_form? }] }.
 */
export function parseGoogleDefinitions(word: string, json: unknown): Definition | null {
  const list = (json as { definitions?: unknown } | null)?.definitions;
  if (!Array.isArray(list)) return null;
  const senses: Sense[] = [];
  let base: string | undefined;
  for (const d of list as { pos?: unknown; entry?: unknown; base_form?: unknown }[]) {
    if (!d || !Array.isArray(d.entry)) continue;
    if (!base && typeof d.base_form === 'string') base = d.base_form;
    const defs = (d.entry as { gloss?: unknown; example?: unknown }[])
      .map((e) => ({ text: typeof e?.gloss === 'string' ? e.gloss : '', example: typeof e?.example === 'string' ? e.example : undefined }))
      .filter((e) => e.text);
    if (defs.length) senses.push({ pos: typeof d.pos === 'string' ? d.pos : '', defs: defs.slice(0, 6) });
  }
  if (!senses.length) return null;
  return { word: base ?? word, senses, source: 'Google' };
}

/** Google's answer with named fields (dj=1): the short translation of the word and the language it detected. */
export function parseGoogleGloss(json: unknown): { gloss?: string; from?: string } {
  const j = json as { sentences?: { trans?: unknown }[]; src?: unknown } | null;
  const gloss = Array.isArray(j?.sentences)
    ? j.sentences
        .map((x) => (typeof x?.trans === 'string' ? x.trans : ''))
        .join('')
        .trim()
    : '';
  return { ...(gloss ? { gloss } : {}), ...(typeof j?.src === 'string' ? { from: j.src } : {}) };
}

/**
 * TDK's dictionary (sozluk.gov.tr/gts, unofficial): a list of entries, one
 * per word of that spelling, [{ madde, anlamlarListe: [{ anlam,
 * orneklerListe?: [{ ornek }], ozelliklerListe?: [{ tur, tam_adi }] }] }],
 * or { error } when there's none. Part of speech is the feature of type 3,
 * usage (mecaz, eskimiş…) of type 4.
 */
export function parseTdk(json: unknown): Definition | null {
  if (!Array.isArray(json)) return null;
  const senses: Sense[] = [];
  let word: string | undefined;
  for (const entry of json as { madde?: unknown; anlamlarListe?: unknown }[]) {
    if (!entry || !Array.isArray(entry.anlamlarListe)) continue;
    if (!word && typeof entry.madde === 'string') word = entry.madde;
    let sense: Sense | null = null;
    for (const a of entry.anlamlarListe as { anlam?: unknown; orneklerListe?: unknown; ozelliklerListe?: unknown }[]) {
      if (typeof a?.anlam !== 'string' || !a.anlam.trim()) continue;
      const features = (Array.isArray(a.ozelliklerListe) ? a.ozelliklerListe : []) as { tur?: unknown; tam_adi?: unknown }[];
      const named = (tur: string) => features.filter((f) => String(f?.tur) === tur && typeof f.tam_adi === 'string').map((f) => f.tam_adi as string);
      const pos = named('3').join(', ');
      // A new part of speech starts a new group; meanings without one belong to the one before.
      if (!sense || (pos && pos !== sense.pos)) {
        sense = { pos, defs: [] };
        senses.push(sense);
      }
      const usage = named('4');
      const examples = (Array.isArray(a.orneklerListe) ? a.orneklerListe : []) as { ornek?: unknown }[];
      const example = examples.find((x) => typeof x?.ornek === 'string')?.ornek as string | undefined;
      const text = stripHtml(a.anlam);
      sense.defs.push({ text: usage.length ? `(${usage.join(', ')}) ${text}` : text, ...(example ? { example: stripHtml(example) } : {}) });
    }
  }
  const kept = senses.filter((x) => x.defs.length).map((x) => ({ ...x, defs: x.defs.slice(0, 8) }));
  if (!word || !kept.length) return null;
  return { word, language: 'Turkish', senses: kept, source: 'TDK' };
}

/** Read Google Translate's answer: [[[translated, original, ...], ...], null, "from", ...]. */
export function parseTranslation(json: unknown): Omit<Translation, 'source'> | null {
  if (!Array.isArray(json) || !Array.isArray(json[0])) return null;
  const text = (json[0] as unknown[])
    .map((p) => (Array.isArray(p) && typeof p[0] === 'string' ? p[0] : ''))
    .join('')
    .trim();
  if (!text) return null;
  return { text, from: typeof json[2] === 'string' ? json[2] : undefined };
}

const gtx = (q: string, to: string, dt: string[], named = false) =>
  `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(to)}&${dt.map((d) => `dt=${d}`).join('&')}${named ? '&dj=1' : ''}&q=${encodeURIComponent(q)}`;

const wiktionaryUrl = (w: string) => `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(w.replace(/ /g, '_'))}`;
const tdkUrl = (w: string) => `https://sozluk.gov.tr/gts?ara=${encodeURIComponent(w)}`;

// ---------- Turkish base words ----------

/**
 * Turkish endings, as patterns: A is a or e, I is ı, i, u or ü, D is d or t,
 * C is c or ç (vowel harmony and consonant assimilation). Verb endings leave a
 * verb stem, looked up as its infinitive ("geldi" → gel → gelmek).
 */
const VERB_ENDINGS =
  'Iyordu Iyorum Iyorsun Iyoruz Iyorlar Iyor yor mIyor AcAktI AcAğIm AcAğIz AcAk yAcAk mAyAcAk mAlIydI mAlI mIştI mIş mAmIş DIlAr DIğImIz DIğInI DIğIm DIğI DIm DIn DIk DInIz DI mAdI ' +
  'ArAk yArAk IncA yIncA Ip yIp Abil yAbil mAz mAk mAsI mA sA An yAn Ar Ir r';
const NOUN_ENDINGS =
  'lArInDAn lArInDA lArInA lArInI lArIn lArI lAr ImIzIn ImIzDAn ImIzDA ImIzA ImIz InIzIn InIzDAn InIzDA InIz mIz nIz ' +
  'InDAn nDAn DAn InDA nDA DA InA nA yA A InI nI yI sI I InIn nIn In Im m ylA lA DIr ki CA lIk sIz lI CI yken ken ydI ymIş ysA';

function expand(pattern: string): string[] {
  const choices: Record<string, string[]> = { A: ['a', 'e'], I: ['ı', 'i', 'u', 'ü'], D: ['d', 't'], C: ['c', 'ç'] };
  let out = [''];
  for (const c of pattern) out = out.flatMap((o) => (choices[c] ?? [c]).map((x) => o + x));
  return out;
}

/** All endings, longest first, with whether they leave a verb stem. */
const ENDINGS: [string, boolean][] = [
  ...VERB_ENDINGS.split(' ').flatMap((p) => expand(p).map((e): [string, boolean] => [e, true])),
  ...NOUN_ENDINGS.split(' ').flatMap((p) => expand(p).map((e): [string, boolean] => [e, false])),
].sort((a, b) => b[0].length - a[0].length);

const VOWEL = /[aeıioöuüâîû]/;
const BACK_VOWELS = 'aıouâû';

/** The infinitive of a verb stem: -mak after a back vowel, -mek after a front one. */
function infinitive(stem: string): string {
  const v = [...stem].reverse().find((c) => VOWEL.test(c));
  return stem + (v && BACK_VOWELS.includes(v) ? 'mak' : 'mek');
}

/** p, ç, t, k at the end of a word become b, c, d, ğ before an ending: back again ("kitabı" → kitap). */
function hardened(stem: string): string | null {
  const to: Record<string, string> = { b: 'p', c: 'ç', d: 't', ğ: 'k', g: 'k' };
  const last = stem[stem.length - 1];
  return to[last] ? stem.slice(0, -1) + to[last] : null;
}

/** TDK is unofficial and sometimes slow: not waited for as long as the others. */
const TDK_TIMEOUT_MS = 7000;
/**
 * TDK's server now and then leaves a connection unanswered (it answers the
 * next one at once): a second request goes out when the first hasn't
 * answered after this long, or failed.
 */
const TDK_AGAIN_MS = 2500;

/**
 * TDK's entry for a word (null: TDK has no such word), asked again once if
 * the first request fails or hangs; the first answer is used. Throws when
 * neither got one.
 */
function askTdk(w: string, signal?: AbortSignal): Promise<Definition | null> {
  return new Promise((resolve, reject) => {
    const tries: AbortController[] = [];
    let failed = 0;
    let done = false;
    let again: ReturnType<typeof setTimeout> | null = null;
    const finish = (f: () => void) => {
      if (done) return;
      done = true;
      if (again) clearTimeout(again);
      tries.forEach((c) => c.abort());
      f();
    };
    const start = () => {
      const ctl = new AbortController();
      tries.push(ctl);
      const stop = () => ctl.abort();
      signal?.addEventListener('abort', stop);
      getJson(tdkUrl(w), IDENTIFIED, ctl.signal, TDK_TIMEOUT_MS)
        .then(
          (json) => finish(() => resolve(parseTdk(json))),
          (e: unknown) => {
            if (signal?.aborted || ++failed === 2) finish(() => reject(e));
            // Failed before the second went out: it goes now.
            else if (tries.length < 2) {
              if (again) clearTimeout(again);
              again = null;
              start();
            }
          },
        )
        .finally(() => signal?.removeEventListener('abort', stop));
    };
    start();
    again = setTimeout(() => {
      again = null;
      if (!done && tries.length < 2) start();
    }, TDK_AGAIN_MS);
  });
}

/** Most base words tried for an inflected one (TDK only knows base words). */
const MAX_STEMS = 4;

/**
 * The verb stems an ending may have left, most likely first. -(I)yor takes
 * the stem's own last vowel: "okuyor" is oku-, "yaşıyor" yaşa- (a and e turn
 * into ı and i before it), "diyor" de-, and "geliyor" gel-, with the vowel
 * only joining. A softened last consonant is hardened again ("gidiyor": git-).
 */
function verbStems(stem: string, ending: string): string[] {
  const out: string[] = [];
  const v = /^[ıiuü]yor/.test(ending) ? ending[0] : null;
  if (v) {
    if (v === 'ı' || v === 'i') out.push(stem + (v === 'ı' ? 'a' : 'e'));
    out.push(stem + v);
  } else if (ending.startsWith('yor') && /[ıi]$/.test(stem)) {
    out.push(stem.slice(0, -1) + (stem.endsWith('ı') ? 'a' : 'e'));
  }
  out.push(stem);
  const hard = hardened(stem);
  if (hard) out.push(hard);
  return out;
}

/**
 * Words a Turkish word may come from, most likely first: its endings trimmed
 * one after another ("evlerinden" → ev; "kızlarımızın" → kızlarımız, kızlar,
 * kız), softened consonants hardened again; after a verb ending only verbs,
 * as infinitives ("okuyorum" → okumak, never "ok", an arrow).
 */
export function turkishStems(word: string): string[] {
  const out: string[] = [];
  const add = (w: string | null) => {
    if (w && w !== word && !out.includes(w)) out.push(w);
  };
  let stem = word;
  for (let peel = 0; peel < 3 && out.length < MAX_STEMS; peel++) {
    const found = ENDINGS.find(([e]) => stem.endsWith(e) && stem.length - e.length >= 2 && VOWEL.test(stem.slice(0, -e.length)));
    if (!found) break;
    const [ending, verb] = found;
    stem = stem.slice(0, -ending.length);
    if (verb) {
      for (const v of verbStems(stem, ending)) add(infinitive(v));
      break;
    }
    add(hardened(stem));
    add(stem);
  }
  return out.slice(0, MAX_STEMS);
}

// ---------- definitions ----------

/** A definition that is only Google's short translation of the word. */
const glossOnly = (word: string, gloss: string): Definition => ({ word, senses: [{ pos: '', defs: [{ text: gloss }] }], source: 'Google' });

/**
 * Definitions of a word in a book of language `lang` (unknown: the language
 * Google detects). Returns null when no dictionary knows it; throws
 * LookupError when none could be reached.
 */
export async function defineWord(text: string, lang?: string, signal?: AbortSignal): Promise<Definition | null> {
  const word = cleanWord(text);
  if (!word) return null;
  let reached = false;
  // Google, asked once: the word's language when the book doesn't say, its
  // short translation, and its own dictionary as a fallback.
  let google: Promise<unknown> | null = null;
  const askGoogle = () =>
    (google ??= getJson(gtx(word, 'en', ['t', 'md'], true), undefined, signal).then(
      (json) => {
        reached = true;
        return json;
      },
      (e) => {
        if (signal?.aborted) throw e;
        return null;
      },
    ));
  const language = normaliseLanguage(lang) ?? normaliseLanguage(parseGoogleGloss(await askGoogle()).from);
  /** Google's translation of the word, when it says something the word doesn't. */
  const gloss = async () => {
    const g = parseGoogleGloss(await askGoogle()).gloss;
    return g && fold(g) !== fold(word) ? g : undefined;
  };
  const wiktionary = async (w: string, only: boolean) => {
    try {
      const def = parseWiktionary(w, await getJson(wiktionaryUrl(w), { Accept: 'application/json', ...IDENTIFIED }, signal), language, only);
      reached = true;
      return def;
    } catch (e) {
      if (signal?.aborted) throw e;
      return null;
    }
  };

  if (language === 'tr') {
    const lower = lowerWord(word, 'tr');
    const stems = turkishStems(lower);
    // Asked meanwhile: the English entry for the word as it is, and Google's translation of it.
    const asIs = wiktionary(lower, true).catch(() => null);
    const meaning = gloss().catch(() => undefined);
    // TDK: the word, or else the word it comes from (TDK only lists base words),
    // one at a time: a burst of requests is what TDK's server is likeliest to leave unanswered.
    let turkish: Definition | null = null;
    try {
      for (const w of [lower, ...stems]) {
        turkish = await askTdk(w, signal);
        reached = true;
        if (turkish) break;
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      // TDK out of reach for now: the English meaning stands alone.
    }
    // The English meaning: Wiktionary's Turkish entry for the base word, or the word, or a word it may come from.
    const base = turkish && turkish.word !== lower ? turkish.word : null;
    let english = (base ? await wiktionary(base, true) : null) ?? (await asIs);
    if (!english && !turkish) {
      const others = [...(word !== lower ? [word] : []), ...stems.slice(0, 2)];
      english = (await Promise.all(others.map((w) => wiktionary(w, true)))).find(Boolean) ?? null;
    }
    const g = await meaning;
    if (signal?.aborted) throw new LookupError('Cancelled');
    if (!english && g) english = glossOnly(word, g);
    // Google's translation of the very word, unless it is already the English meaning shown.
    const extra = g && english?.source !== 'Google' ? { gloss: g } : {};
    if (turkish) return { ...turkish, ...(english ? { english } : {}), ...extra };
    if (english) return { ...english, ...extra };
    if (!reached) throw new LookupError('No connection', true);
    return null;
  }

  const lower = lowerWord(word, language);
  for (const w of [...new Set([word, lower])]) {
    const def = await wiktionary(w, false);
    if (def) return def;
  }
  const def = parseGoogleDefinitions(word, await askGoogle());
  if (def) return def;
  const g = await gloss();
  if (g) return glossOnly(word, g);
  if (!reached) throw new LookupError('No connection', true);
  return null;
}

/**
 * Longest text sent in one request, counted as it travels in the address
 * (a Cyrillic letter takes 6 characters there, a Chinese one 9): servers
 * refuse addresses much longer than this.
 */
export const MAX_ENCODED = 6000;

/** Text with any broken surrogate pairs (from a damaged book) replaced, so it can be sent. */
export function wellFormed(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        out += text[i] + text[i + 1];
        i++;
      } else out += '\uFFFD';
    } else out += c >= 0xdc00 && c <= 0xdfff ? '\uFFFD' : text[i];
  }
  return out;
}

const encodedLength = (s: string) => encodeURIComponent(s).length;

/**
 * The beginning of `text` that fits in one request, cut at a sentence (or a
 * space) when it doesn't all fit. `size` measures a piece of text; by default
 * its length in the address.
 */
export function fitForRequest(text: string, max = MAX_ENCODED, size: (s: string) => number = encodedLength): string {
  if (size(text) <= max) return text;
  // Never end on the first half of a pair: that can't be encoded.
  const end = (n: number) => (n > 0 && /[\uD800-\uDBFF]/.test(text[n - 1]) ? n - 1 : n);
  // Longest prefix that fits, then back to the last sentence end or space in it.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(text.slice(0, end(mid))) <= max) lo = mid;
    else hi = mid - 1;
  }
  lo = end(lo);
  const head = text.slice(0, lo);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('。'));
  if (sentence > lo / 2) return head.slice(0, sentence + 1);
  const space = head.lastIndexOf(' ');
  return space > lo / 2 ? head.slice(0, space) : head;
}

/** MyMemory takes at most 500 characters per request\u2026 */
export const MYMEMORY_PIECE = 500;
/** \u2026and 5,000 a day without an account: a long selection sends only its beginning. */
export const MYMEMORY_TOTAL = 1500;

/**
 * Read MyMemory's answer. Its errors (text too long, daily limit used up)
 * come back as a "translation" with another responseStatus: null then.
 */
export function parseMyMemory(json: unknown): Omit<Translation, 'source'> | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as { responseStatus?: unknown; quotaFinished?: unknown; responseData?: { translatedText?: unknown; detectedLanguage?: unknown } };
  if (Number(j.responseStatus) !== 200 || j.quotaFinished === true) return null;
  const text = typeof j.responseData?.translatedText === 'string' ? j.responseData.translatedText.trim() : '';
  if (!text) return null;
  const from = j.responseData?.detectedLanguage;
  return { text, from: typeof from === 'string' ? from : undefined };
}

async function viaGoogle(all: string, to: string, signal?: AbortSignal): Promise<Translation> {
  const q = fitForRequest(all);
  const t = parseTranslation(await getJson(gtx(q, to, ['t']), undefined, signal));
  if (!t) throw new LookupError('Empty translation');
  return { ...t, source: 'Google Translate', ...(q.length < all.length ? { partial: true } : {}) };
}

async function viaMyMemory(all: string, to: string, signal?: AbortSignal): Promise<Translation> {
  const chars = (s: string) => s.length;
  const q = fitForRequest(all, MYMEMORY_TOTAL, chars);
  const parts: string[] = [];
  let from: string | undefined;
  for (let rest = q; rest; ) {
    const piece = fitForRequest(rest, MYMEMORY_PIECE, chars);
    rest = rest.slice(piece.length).trimStart();
    const url = `https://api.mymemory.translated.net/get?langpair=autodetect|${encodeURIComponent(to)}&q=${encodeURIComponent(piece)}`;
    const t = parseMyMemory(await getJson(url, undefined, signal));
    if (!t) throw new LookupError('Empty translation');
    parts.push(t.text);
    from ??= t.from;
  }
  if (!parts.length) throw new LookupError('Empty translation');
  return { text: parts.join(' '), from, source: 'MyMemory', ...(q.length < all.length ? { partial: true } : {}) };
}

/**
 * Translate a selection. Google Translate first: the best translations, but
 * no official API, and it turns away addresses it thinks send too many
 * requests. When it fails, MyMemory (official, free, a daily limit) takes over.
 */
export async function translateText(text: string, to: string, signal?: AbortSignal): Promise<Translation> {
  const all = wellFormed(text.replace(/\u00AD/g, '').trim());
  try {
    return await viaGoogle(all, to, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    return viaMyMemory(all, to, signal);
  }
}
