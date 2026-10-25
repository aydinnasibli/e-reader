// Definitions and translations shown inside the app. No keys: definitions come
// from Wiktionary (every language, explained in English), with Google's
// dictionary as a fallback; translations from Google Translate, with MyMemory
// as a fallback.

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
  source: 'Wiktionary' | 'Google';
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

export function languageName(code?: string): string | undefined {
  if (!code) return undefined;
  const c = code.toLowerCase();
  return LANGUAGES.find((l) => l.code.toLowerCase() === c || l.code.slice(0, 2) === c.slice(0, 2))?.name;
}

const TIMEOUT_MS = 12000;

/** Thrown when there is no connection (`offline`) or the service didn't answer properly. */
export class LookupError extends Error {
  constructor(
    message: string,
    readonly offline = false,
  ) {
    super(message);
  }
}

async function getJson(url: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<unknown | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
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

/** The word to look up from a selection: no punctuation around it. */
export function cleanWord(text: string): string {
  return text
    .replace(/[­​]/g, '')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
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

/** Read Wiktionary's answer, preferring the entry in the book's language. */
export function parseWiktionary(word: string, json: unknown, lang?: string): Definition | null {
  if (!json || typeof json !== 'object') return null;
  const byLang = json as Record<string, WikiSense[]>;
  const codes = Object.keys(byLang).filter((k) => Array.isArray(byLang[k]));
  const want = lang?.slice(0, 2).toLowerCase();
  const code = (want && codes.find((c) => c === want)) || codes.find((c) => c === 'en') || codes[0];
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

/**
 * Definitions of a word. Returns null when no dictionary knows it; throws
 * LookupError when neither could be reached.
 */
export async function defineWord(text: string, lang?: string, signal?: AbortSignal): Promise<Definition | null> {
  const word = cleanWord(text);
  if (!word) return null;
  let reached = false;
  const tries = word === word.toLowerCase() ? [word] : [word, word.toLowerCase()];
  for (const w of tries) {
    try {
      const json = await getJson(
        `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(w.replace(/ /g, '_'))}`,
        {
          Accept: 'application/json',
          'Api-User-Agent': 'NecReader/1.0 (e-book reader app)',
        },
        signal,
      );
      reached = true;
      const def = parseWiktionary(w, json, lang);
      if (def) return def;
    } catch (e) {
      if (signal?.aborted) throw e;
    }
  }
  try {
    const def = parseGoogleDefinitions(word, await getJson(gtx(word, 'en', ['t', 'md'], true), undefined, signal));
    reached = true;
    if (def) return def;
  } catch (e) {
    if (!reached || signal?.aborted) throw e;
  }
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
