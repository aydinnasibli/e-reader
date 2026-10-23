import { describe, expect, it } from 'vitest';
import { MAX_ENCODED, cleanWord, fitForRequest, parseGoogleDefinitions, parseTranslation, parseWiktionary, stripHtml, wellFormed } from '../src/lib/lookup';

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
