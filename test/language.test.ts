import { describe, expect, it } from 'vitest';
import { bookLanguage, guessLanguage, normaliseLanguage } from '@/engine/language';
import { enc, ingestBytes, makeEpub, xhtml } from './helpers';

describe('language tags', () => {
  it('two-letter codes from tags, three-letter codes and names', () => {
    expect(normaliseLanguage('tr-TR')).toBe('tr');
    expect(normaliseLanguage('TR')).toBe('tr');
    expect(normaliseLanguage('tur')).toBe('tr');
    expect(normaliseLanguage('Turkish')).toBe('tr');
    expect(normaliseLanguage('Türkçe')).toBe('tr');
    expect(normaliseLanguage('en_US')).toBe('en');
    expect(normaliseLanguage('eng')).toBe('en');
    expect(normaliseLanguage('rus')).toBe('ru');
  });

  it('nothing for empty or unknown tags', () => {
    expect(normaliseLanguage(undefined)).toBeUndefined();
    expect(normaliseLanguage('')).toBeUndefined();
    expect(normaliseLanguage('  ')).toBeUndefined();
    expect(normaliseLanguage('klingon')).toBeUndefined();
  });
});

const TURKISH =
  'Ağaçların gölgesinde oturan yaşlı adam, İstanbul’un eski sokaklarını düşünüyordu. Işık yavaş yavaş kayboluyor, ' +
  'deniz kıyısındaki evlerin pencerelerinde lambalar yanıyordu. Çocukluğunda bu sokaklarda koşar, arkadaşlarıyla ' +
  'saklambaç oynardı. Şimdi her şey değişmişti ama denizin kokusu hâlâ aynıydı. Bir süre daha oturdu, sonra ' +
  'kalkıp ağır adımlarla evine doğru yürüdü. Kapının önünde durdu ve gökyüzüne baktı; yıldızlar birer birer çıkıyordu.';
const ENGLISH =
  'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife. ' +
  'However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is ' +
  'so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or ' +
  'other of their daughters. "My dear Mr. Bennet," said his lady to him one day, "have you heard that Netherfield Park is let at last?"';
const RUSSIAN =
  'Все счастливые семьи похожи друг на друга, каждая несчастливая семья несчастлива по-своему. Все смешалось в доме ' +
  'Облонских. Жена узнала, что муж был в связи с бывшею в их доме француженкою-гувернанткой, и объявила мужу, что не ' +
  'может жить с ним в одном доме. Положение это продолжалось уже третий день и мучительно чувствовалось и самими супругами.';

describe('guessing a book’s language from its text', () => {
  it('Turkish, from the letters only Turkish uses', () => {
    expect(guessLanguage(TURKISH)).toBe('tr');
  });

  it('English and Russian, from their common words', () => {
    expect(guessLanguage(ENGLISH)).toBe('en');
    expect(guessLanguage(RUSSIAN)).toBe('ru');
  });

  it('an English book with a few Turkish names is still English', () => {
    expect(guessLanguage(`${ENGLISH} They met in İstanbul, near Beşiktaş. ${ENGLISH}`)).toBe('en');
  });

  it('no guess from too little text', () => {
    expect(guessLanguage('Merhaba dünya')).toBeUndefined();
  });
});

describe('a book’s language', () => {
  const paras = (text: string, n = 8) => Array.from({ length: n }, () => `<p>${text}</p>`).join('');

  it('the metadata’s, normalised, unless the text clearly says otherwise', () => {
    expect(bookLanguage('tur', TURKISH)).toBe('tr');
    expect(bookLanguage('en-US', ENGLISH)).toBe('en');
    // Tools stamp books "en" whatever they are.
    expect(bookLanguage('en', `${TURKISH} ${TURKISH}`)).toBe('tr');
    expect(bookLanguage('tr', `${ENGLISH} They met in İstanbul. ${ENGLISH}`)).toBe('en');
    // Not enough text to overrule it.
    expect(bookLanguage('de', 'Merhaba dünya')).toBe('de');
    expect(bookLanguage(undefined, RUSSIAN)).toBe('ru');
    expect(bookLanguage('', 'Hi')).toBeUndefined();
  });

  it('is in the manifest: guessed for TXT, from the metadata (checked) for EPUB and FB2', async () => {
    expect((await ingestBytes(enc(`${TURKISH}\n\n`.repeat(5)), 'k.txt')).manifest.lang).toBe('tr');
    expect((await ingestBytes(makeEpub({ chapters: { 'a.xhtml': xhtml(paras(ENGLISH)) }, metadata: '<dc:title>T</dc:title><dc:language>eng</dc:language>' }), 'x.epub')).manifest.lang).toBe('en');
    expect((await ingestBytes(makeEpub({ chapters: { 'a.xhtml': xhtml(paras(TURKISH)) }, metadata: '<dc:title>T</dc:title><dc:language>en</dc:language>' }), 'x.epub')).manifest.lang).toBe('tr');
    const fb2 = `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info><lang>tur</lang></title-info></description><body><section>${paras(TURKISH, 3)}</section></body></FictionBook>`;
    expect((await ingestBytes(enc(fb2), 'k.fb2')).manifest.lang).toBe('tr');
  });
});
