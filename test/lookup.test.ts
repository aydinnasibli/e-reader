import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_ENCODED,
  USER_AGENT,
  cleanWord,
  defineWord,
  fitForRequest,
  lowerWord,
  parseGoogleDefinitions,
  parseTdk,
  parseTranslation,
  parseWiktionary,
  stripHtml,
  turkishStems,
  wellFormed,
} from '../src/lib/lookup';

describe('in-app dictionary and translation', () => {
  it('cleans the selected word', () => {
    expect(cleanWord('“Whale,”')).toBe('Whale');
    expect(cleanWord('(hy­phen)…')).toBe('hyphen');
    expect(cleanWord('Ölməz!')).toBe('Ölməz');
    expect(cleanWord('—')).toBe('');
  });

  it('keeps only the text of Wiktionary definitions', () => {
    expect(stripHtml('A <a rel="mw:WikiLink" href="/wiki/large">large</a> &amp; <i>marine</i>&#160;mammal &#x2014; see')).toBe('A large & marine mammal — see');
  });

  it("prefers the entry in the book's language, then English", () => {
    const json = {
      en: [{ partOfSpeech: 'Noun', language: 'English', definitions: [{ definition: 'greeting' }] }],
      az: [
        { partOfSpeech: 'Interjection', language: 'Azerbaijani', definitions: [{ definition: '<b>hello</b>', parsedExamples: [{ example: 'Salam, dost!' }] }, { definition: '' }] },
      ],
    };
    expect(parseWiktionary('salam', json, 'az')).toEqual({
      word: 'salam',
      language: 'Azerbaijani',
      senses: [{ pos: 'Interjection', defs: [{ text: 'hello', example: 'Salam, dost!' }] }],
      source: 'Wiktionary',
    });
    expect(parseWiktionary('salam', json, 'fr')?.language).toBe('English');
    expect(parseWiktionary('salam', json)?.language).toBe('English');
    expect(parseWiktionary('x', { en: [{ definitions: [{ definition: '' }] }] })).toBeNull();
    expect(parseWiktionary('x', null)).toBeNull();
  });

  it("reads Google's dictionary answer", () => {
    const json = { sentences: [{ trans: 'whales', orig: 'whales' }], definitions: [{ pos: 'noun', entry: [{ gloss: 'a very large marine mammal', example: 'a blue whale' }], base_form: 'whale' }] };
    expect(parseGoogleDefinitions('whales', json)).toEqual({
      word: 'whale',
      senses: [{ pos: 'noun', defs: [{ text: 'a very large marine mammal', example: 'a blue whale' }] }],
      source: 'Google',
    });
    expect(parseGoogleDefinitions('x', { sentences: [] })).toBeNull();
    expect(parseGoogleDefinitions('x', [])).toBeNull();
  });

  it('joins translated sentences and reads the detected language', () => {
    // A real answer from the service.
    const json = [[['Hello world. ', 'Salam dünya. ', null, null, 10], ['I am reading a book.', 'Kitab oxuyuram.', null, null, 10]], null, 'az'];
    expect(parseTranslation(json)).toEqual({ text: 'Hello world. I am reading a book.', from: 'az' });
    expect(parseTranslation('<html>')).toBeNull();
    expect(parseTranslation([[], null, 'en'])).toBeNull();
  });

  it('long selections are cut to what one request can carry, at a sentence', () => {
    const short = 'Короткий текст.';
    expect(fitForRequest(short)).toBe(short);
    // Cyrillic takes 6 characters per letter in the address: 4000 letters would be 24 000.
    const long = 'Это предложение. '.repeat(240);
    const cut = fitForRequest(long);
    expect(encodeURIComponent(cut).length).toBeLessThanOrEqual(MAX_ENCODED);
    expect(cut.endsWith('предложение.')).toBe(true);
    expect(long.startsWith(cut)).toBe(true);
    // Emoji (surrogate pairs) are never cut in half.
    const emoji = '😀'.repeat(2000);
    expect(() => encodeURIComponent(fitForRequest(emoji))).not.toThrow();
  });

  it('broken characters from a damaged book can still be sent', () => {
    const broken = 'a\uD800b\uDC00c😀';
    expect(() => encodeURIComponent(wellFormed(broken))).not.toThrow();
    expect(wellFormed(broken)).toBe('a\uFFFDb\uFFFDc😀');
  });
});

// ---------- Look Up on the network (a fake one shaped like the real answers, captured live) ----------

const json = (status: number, body: unknown) => ({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)) });
const sense = (language: string, definition: string) => [{ partOfSpeech: 'Noun', language, definitions: [{ definition }] }];
/** en.wiktionary's REST definitions: exact titles only ("işık" and "i̇nsan" are 404); "insan" lists Albanian first. */
const WIKT: Record<string, Record<string, unknown[]>> = {
  ışık: { tr: sense('Turkish', 'light (electromagnetic wave)') },
  insan: { sq: sense('Albanian', 'person, human'), tr: sense('Turkish', 'human') },
  kuş: { tr: sense('Turkish', 'bird') },
  ev: { az: sense('Azerbaijani', 'house'), tr: sense('Turkish', 'house, home') },
  serendipity: { en: sense('English', 'a happy accident') },
};
/** TDK: base words only, case-sensitive, verbs as infinitives; { error } when there's nothing. */
const TDK: Record<string, unknown[]> = {
  ev: [{ madde: 'ev', anlamlarListe: [{ anlam: 'Bir kimsenin veya ailenin içinde yaşadığı yer', ozelliklerListe: [{ tur: '3', tam_adi: 'isim' }] }, { anlam: '► aile', orneklerListe: [{ ornek: 'Evine bağlı bir adam.' }], ozelliklerListe: [{ tur: '4', tam_adi: 'mecaz' }] }] }],
  ışık: [{ madde: 'ışık', anlamlarListe: [{ anlam: 'Cisimleri görmeyi sağlayan fiziksel enerji', ozelliklerListe: [{ tur: '3', tam_adi: 'isim' }] }] }],
  insan: [{ madde: 'insan', anlamlarListe: [{ anlam: 'Düşünme ve konuşma yeteneği olan canlı', ozelliklerListe: [{ tur: '3', tam_adi: 'isim' }] }] }],
  gelmek: [{ madde: 'gelmek', anlamlarListe: [{ anlam: 'Ulaşmak, varmak', ozelliklerListe: [{ tur: '3', tam_adi: 'nesnesiz' }] }] }],
  kitap: [{ madde: 'kitap', anlamlarListe: [{ anlam: 'Ciltli veya ciltsiz olarak bir araya getirilmiş basılı veya yazılı kâğıt yaprakların bütünü' }] }],
};
/** Google's dt=md answer for a Turkish word: no dictionary, only its translation and detected language. */
const GLOSS: Record<string, string> = { evlerinden: 'from their homes', işık: 'Light', ışık: 'Light', insan: 'human', geldiler: 'they came' };

let calls: { host: string; q: string; headers: Record<string, string> }[] = [];
function network({ tdk = true, wikimedia = true } = {}) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      const u = new URL(url);
      const q = u.hostname === 'en.wiktionary.org' ? decodeURIComponent(u.pathname.split('/').pop()!).replace(/_/g, ' ') : (u.searchParams.get('ara') ?? u.searchParams.get('q') ?? '');
      calls.push({ host: u.hostname, q, headers: init?.headers ?? {} });
      if (u.hostname === 'en.wiktionary.org') {
        if (!wikimedia) throw new TypeError('Network request failed');
        // Wikimedia turns away requests without a proper User-Agent (Android's default is okhttp's).
        if (!/NecReader/.test(init?.headers?.['User-Agent'] ?? '')) return json(403, { title: 'Please set a user-agent' });
        return WIKT[q] ? json(200, WIKT[q]) : json(404, { type: 'not_found' });
      }
      if (u.hostname === 'sozluk.gov.tr') {
        if (!tdk) throw new TypeError('Network request failed');
        return json(200, TDK[q] ?? { error: 'Sonuç bulunamadı' });
      }
      if (u.hostname === 'translate.googleapis.com') return json(200, { sentences: [{ trans: GLOSS[q.toLocaleLowerCase('tr')] ?? q, orig: q }], src: /[ışğİ]|evler|insan|gel/i.test(q) ? 'tr' : 'en' });
      throw new TypeError('Network request failed');
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

describe('looking up words', () => {
  it('Wiktionary is asked with a User-Agent of the app’s own (else Wikimedia answers 403)', async () => {
    network();
    expect((await defineWord('serendipity', 'en'))?.senses[0].defs[0].text).toBe('a happy accident');
    expect(calls[0].headers['User-Agent']).toBe(USER_AGENT);
  });

  it('a Turkish word gets TDK’s Turkish definition with the English meaning under it', async () => {
    network();
    const def = await defineWord('Işık', 'tr-TR');
    expect(def).toMatchObject({ word: 'ışık', source: 'TDK', english: { word: 'ışık', source: 'Wiktionary', senses: [{ defs: [{ text: 'light (electromagnetic wave)' }] }] } });
    expect(def?.senses[0]).toEqual({ pos: 'isim', defs: [{ text: 'Cisimleri görmeyi sağlayan fiziksel enerji' }] });
    expect(calls.find((c) => c.host === 'sozluk.gov.tr')?.headers['User-Agent']).toBe(USER_AGENT);
  });

  it('an inflected word is looked up as the word it comes from, with Google’s translation of the form itself', async () => {
    network();
    const def = await defineWord('evlerinden,', 'tr');
    expect(def).toMatchObject({ word: 'ev', source: 'TDK', gloss: 'from their homes', english: { senses: [{ defs: [{ text: 'house, home' }] }] } });
    // Usage labels and examples come along.
    expect(def?.senses[0].defs[1]).toEqual({ text: '(mecaz) ► aile', example: 'Evine bağlı bir adam.' });
    // A few requests at most.
    expect(calls.filter((c) => c.host === 'sozluk.gov.tr').length).toBeLessThanOrEqual(5);
  });

  it('a verb form is looked up as its infinitive', async () => {
    network();
    // Wiktionary has no entry for it here: Google's translation of the form is the English meaning.
    expect(await defineWord('Geldiler', 'tr')).toMatchObject({ word: 'gelmek', source: 'TDK', english: { source: 'Google', senses: [{ defs: [{ text: 'they came' }] }] } });
  });

  it('turkishStems: endings trimmed, softened consonants hardened, verb stems as infinitives', () => {
    expect(turkishStems('evlerinden')).toContain('ev');
    expect(turkishStems('kitabı')[0]).toBe('kitap');
    expect(turkishStems('geliyordu')).toContain('gelmek');
    expect(turkishStems('kızlarımızın')).toContain('kız');
    expect(turkishStems('ev')).toEqual([]);
  });

  it('a -yor verb is looked up as its own verb: the stem’s last vowel isn’t taken for the ending', () => {
    const cases: [string, string][] = [
      ['okuyor', 'okumak'], // not okmak, nor ok (an arrow)
      ['okuyorum', 'okumak'],
      ['yaşıyor', 'yaşamak'], // not yaş (age)
      ['arıyor', 'aramak'],
      ['taşıyor', 'taşımak'], // not taşmak (to overflow)
      ['uyuyor', 'uyumak'], // not uymak (to conform)
      ['yıkıyor', 'yıkamak'], // not yıkmak (to demolish)
      ['istiyorum', 'istemek'],
      ['diyor', 'demek'],
      ['gidiyor', 'gitmek'],
    ];
    for (const [form, verb] of cases) expect([form, turkishStems(form)]).toEqual([form, expect.arrayContaining([verb])]);
    // After a verb ending, only verbs: never the bare stem, which may be another word.
    expect(turkishStems('okuyor')).not.toContain('ok');
    expect(turkishStems('yaşıyor')).not.toContain('yaş');
  });

  it('Look Up on "okuyorum" shows TDK’s "okumak", not "ok" (an arrow), though TDK has both', async () => {
    network();
    TDK.okumak = [{ madde: 'okumak', anlamlarListe: [{ anlam: 'Yazılı bir metni sesli veya sessiz olarak dile çevirmek', ozelliklerListe: [{ tur: '3', tam_adi: 'nesnesiz' }] }] }];
    TDK.ok = [{ madde: 'ok', anlamlarListe: [{ anlam: 'Yayla atılan, ucu sivri, ince, uzun çubuk', ozelliklerListe: [{ tur: '3', tam_adi: 'isim' }] }] }];
    try {
      expect((await defineWord('okuyorum', 'tr'))?.word).toBe('okumak');
    } finally {
      delete TDK.okumak;
      delete TDK.ok;
    }
  });

  it('with TDK out of reach: Wiktionary’s Turkish entry, found the Turkish way ("İnsan" is "insan", not "i̇nsan")', async () => {
    network({ tdk: false });
    expect(await defineWord('İnsan', 'tr')).toMatchObject({ word: 'insan', language: 'Turkish', source: 'Wiktionary' });
    expect((await defineWord('Işık', 'tr'))?.word).toBe('ışık');
    // An inflected word Wiktionary doesn't have: Google's translation instead of "No dictionary entry".
    expect(JSON.stringify(await defineWord('evlerinden', 'tr'))).toContain('from their homes');
  });

  it('TDK not answering once (its server sometimes drops a connection) doesn’t lose the Turkish definition: it is asked again', async () => {
    TDK.ılık = [{ madde: 'ılık', anlamlarListe: [{ anlam: 'Soğukla sıcak arası, ne soğuk ne sıcak', ozelliklerListe: [{ tur: '3', tam_adi: 'sıfat' }] }] }];
    try {
      // The first request fails outright.
      network();
      const real = fetch as unknown as (u: string, i?: unknown) => Promise<unknown>;
      let tdkCalls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init?: unknown) => (new URL(url).hostname === 'sozluk.gov.tr' && ++tdkCalls === 1 ? Promise.reject(new TypeError('Network request failed')) : real(url, init))),
      );
      expect(await defineWord('ılık', 'tr')).toMatchObject({ word: 'ılık', source: 'TDK' });
      expect(tdkCalls).toBe(2);

      // The first request is left unanswered: a second goes out after a moment, and its answer is used.
      network();
      const real2 = fetch as unknown as (u: string, i?: { signal?: AbortSignal }) => Promise<unknown>;
      tdkCalls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init?: { signal?: AbortSignal }) => {
          if (new URL(url).hostname === 'sozluk.gov.tr' && ++tdkCalls === 1) {
            return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('Aborted'))));
          }
          return real2(url, init);
        }),
      );
      const started = Date.now();
      expect(await defineWord('ılık', 'tr')).toMatchObject({ word: 'ılık', source: 'TDK' });
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      delete TDK.ılık;
    }
  }, 15000);

  it('TDK out of reach: asked twice at most, its base words not tried one by one, and the English meaning shown', async () => {
    network({ tdk: false });
    const def = await defineWord('evlerinden', 'tr');
    expect(calls.filter((c) => c.host === 'sozluk.gov.tr')).toHaveLength(2);
    expect(JSON.stringify(def)).toContain('from their homes');
  });

  it('a book with no language (a TXT file): the word’s language as Google detects it, not the first one Wiktionary lists', async () => {
    network({ tdk: false });
    expect((await defineWord('insan'))?.language).toBe('Turkish');
  });

  it('nothing reachable: says there’s no connection', async () => {
    network({ tdk: false, wikimedia: false });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Network request failed'))));
    await expect(defineWord('ışık', 'tr')).rejects.toMatchObject({ offline: true });
  });

  it('no request goes out after the card was closed', async () => {
    const card = new AbortController();
    const hosts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        hosts.push(new URL(url).hostname);
        // Wiktionary answers with nothing usable, and the person closes the card meanwhile.
        card.abort();
        return { ok: true, status: 200, text: () => Promise.resolve('{}') };
      }),
    );
    await defineWord('serendipity', 'en', card.signal).catch(() => null);
    expect(hosts).toEqual(['en.wiktionary.org']);
  });

  it('text written decomposed keeps its last letter: "kuş" is not cut to "kus"', () => {
    expect(cleanWord('kuş'.normalize('NFD'))).toBe('kuş');
    expect(lowerWord('IŞIK', 'tr')).toBe('ışık');
    expect(lowerWord('İstanbul', 'en')).toBe('istanbul');
  });

  it('a character code beyond the last one (a damaged entry) is shown as written: the look-up doesn’t wait forever', async () => {
    expect(stripHtml('a &#1114112; b &#x110000; c &#233;')).toBe('a &#1114112; b &#x110000; c é');
    network();
    TDK.damla = [{ madde: 'damla', anlamlarListe: [{ anlam: 'Sıvının yuvarlak parçası &#99999999;', ozelliklerListe: [{ tur: '3', tam_adi: 'isim' }] }] }];
    const def = await Promise.race([defineWord('damla', 'tr'), new Promise((r) => setTimeout(() => r('still waiting'), 3000))]);
    expect(def).toMatchObject({ word: 'damla', source: 'TDK', senses: [{ defs: [{ text: 'Sıvının yuvarlak parçası &#99999999;' }] }] });
  });

  it('reads TDK’s answer, and its "not found"', () => {
    expect(parseTdk({ error: 'Sonuç bulunamadı' })).toBeNull();
    expect(parseTdk(TDK.gelmek)).toEqual({ word: 'gelmek', language: 'Turkish', source: 'TDK', senses: [{ pos: 'nesnesiz', defs: [{ text: 'Ulaşmak, varmak' }] }] });
  });
});
