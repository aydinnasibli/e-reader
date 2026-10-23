import { describe, expect, it } from 'vitest';
import { cleanWord, parseGoogleDefinitions, parseTranslation, parseWiktionary, stripHtml } from '../src/lib/lookup';

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
});
