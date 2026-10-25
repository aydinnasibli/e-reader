// Translation falls back to MyMemory when Google Translate turns the app away
// (it answers "unusual traffic" pages or 429 to busy addresses), and MyMemory's
// own errors are never shown as a translation.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LookupError, MYMEMORY_PIECE, MYMEMORY_TOTAL, parseMyMemory, translateText } from '../src/lib/lookup';

type Reply = { status?: number; body: unknown };
const calls: string[] = [];

function serve(google: Reply | 'offline', mymemory: (q: string) => Reply | 'offline' = (q) => memory(`[ru] ${q}`)) {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      const u = new URL(url);
      const r = u.hostname === 'translate.googleapis.com' ? google : mymemory(u.searchParams.get('q') ?? '');
      if (r === 'offline') throw new TypeError('Network request failed');
      const status = r.status ?? 200;
      return { status, ok: status >= 200 && status < 300, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
    }),
  );
}

const memory = (text: string, from = 'en'): Reply => ({ body: { responseStatus: 200, quotaFinished: false, responseData: { translatedText: text, detectedLanguage: from } } });
const googleOk: Reply = { body: [[['Привет мир.', 'Hello world.', null, null, 10]], null, 'en'] };
const blocked: Reply = { status: 429, body: '<html><title>Sorry...</title>unusual traffic</html>' };
const viaMyMemory = () => calls.filter((c) => c.includes('mymemory'));

afterEach(() => vi.unstubAllGlobals());

describe('translation', () => {
  it('uses Google Translate when it answers', async () => {
    serve(googleOk);
    expect(await translateText('Hello world.', 'ru')).toEqual({ text: 'Привет мир.', from: 'en', source: 'Google Translate' });
    expect(viaMyMemory()).toHaveLength(0);
  });

  it('falls back to MyMemory when Google blocks the app, answers a web page, or is unreachable', async () => {
    for (const google of [blocked, { body: '<html>sign in</html>' }, 'offline' as const]) {
      serve(google);
      expect(await translateText('Hello world.', 'ru')).toEqual({ text: '[ru] Hello world.', from: 'en', source: 'MyMemory' });
      expect(new URL(viaMyMemory()[0]).searchParams.get('langpair')).toBe('autodetect|ru');
    }
  });

  it('sends a long selection to MyMemory in pieces it accepts, and says when only the beginning was translated', async () => {
    serve(blocked);
    const sentence = 'The sea was calm that night and nobody spoke. ';
    const long = sentence.repeat(60).trim();
    const t = await translateText(long, 'ru');
    const pieces = viaMyMemory().map((c) => new URL(c).searchParams.get('q')!);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(MYMEMORY_PIECE);
      expect(p.endsWith('spoke.')).toBe(true);
    }
    expect(pieces.join(' ').length).toBeLessThanOrEqual(MYMEMORY_TOTAL);
    expect(long.startsWith(pieces.join(' '))).toBe(true);
    expect(t.partial).toBe(true);
    expect(t.text).toBe(pieces.map((p) => `[ru] ${p}`).join(' '));
  });

  it("never shows MyMemory's error messages as a translation", async () => {
    const quota: Reply = {
      body: { responseStatus: 429, quotaFinished: true, responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY.' } },
    };
    const tooLong: Reply = { body: { responseStatus: '403', responseData: { translatedText: 'QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS' } } };
    for (const reply of [quota, tooLong]) {
      serve(blocked, () => reply);
      await expect(translateText('Hello world.', 'ru')).rejects.toBeInstanceOf(LookupError);
    }
    expect(parseMyMemory(quota.body)).toBeNull();
    expect(parseMyMemory(tooLong.body)).toBeNull();
  });

  it('reports no connection when neither service can be reached', async () => {
    serve('offline', () => 'offline');
    await expect(translateText('Hello world.', 'ru')).rejects.toMatchObject({ offline: true });
  });

  it('does not try MyMemory after the card was closed', async () => {
    serve('offline');
    const ctl = new AbortController();
    ctl.abort();
    await expect(translateText('Hello world.', 'ru', ctl.signal)).rejects.toBeInstanceOf(LookupError);
    expect(viaMyMemory()).toHaveLength(0);
  });
});
