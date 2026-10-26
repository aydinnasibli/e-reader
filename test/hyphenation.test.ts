import { describe, expect, it, vi } from 'vitest';
import type { Block } from '../src/engine/types';
import { hyphenPoints, pickLanguage } from '../src/reader/hyphenate';
import { type Look, drawn, toBlock, toDrawn } from '../src/reader/look';

// look.ts pulls in fonts and react-native for styles; none of that is needed here.
vi.mock('react-native', () => ({ Platform: { select: (o: Record<string, unknown>) => o.default } }));
vi.mock('@/lib/fonts', () => ({ fontFace: () => ({}) }));

const look = (hyph: string | undefined, prefix = ''): Look => ({
  fontSize: 10,
  lineHeight: 10,
  font: 'serif',
  weight: 'regular',
  bold: false,
  letterSpacing: 0,
  textAlign: 'left',
  marginTop: 0,
  marginBottom: 0,
  paddingLeft: 0,
  prefix,
  hyph,
});

describe('hyphenation', () => {
  it('picks patterns from the book language or the script', () => {
    expect(pickLanguage('ru-RU', 'Привет мир')).toBe('ru');
    expect(pickLanguage('en', 'Привет мир')).toBe('ru');
    expect(pickLanguage(undefined, 'Hello world')).toBe('en');
    expect(pickLanguage('az', 'Salam dünya')).toBe('tr');
    expect(pickLanguage(undefined, '12345')).toBeNull();
  });

  it('takes the language however the book names it, or tells it from the text', () => {
    expect(pickLanguage('tur', 'Kitaplarımızdan geldik')).toBe('tr');
    expect(pickLanguage('Turkish', 'Kitaplarımızdan geldik')).toBe('tr');
    expect(pickLanguage('tr-TR', 'Kitaplarımızdan geldik')).toBe('tr');
    // A book that doesn't say (TXT): a paragraph long enough to tell.
    const tr = 'Bu kitap, uzun bir yolculuğun ve o yolculukta karşılaşılan insanların hikâyesidir. '.repeat(4);
    expect(pickLanguage(undefined, tr)).toBe('tr');
    // Too short to tell: by the script.
    expect(pickLanguage(undefined, 'kitaplarımızdan geldik')).toBe('en');
  });

  it('Turkish: a word with a capital İ or I breaks where it does in lower case', () => {
    const show = (w: string) => {
      const pts = hyphenPoints(w, 'tr');
      let out = '';
      for (let i = 0; i < w.length; i++) out += (pts.includes(i) ? '-' : '') + w[i];
      return out;
    };
    expect(show('istanbul')).toBe('is-tan-bul');
    expect(show('İstanbul')).toBe('İs-tan-bul');
    expect(show('İnsanlığın')).toBe('İn-san-lı-ğın');
    expect(show('Öğretmenimiz')).toBe('Öğ-ret-me-ni-miz');
    expect(show('ISLAKLIĞI')).toBe(show('ıslaklığı').toLocaleUpperCase('tr'));
  });

  it('finds syllable break points', () => {
    const text = 'international';
    const pts = hyphenPoints(text, 'en');
    expect(pts.length).toBeGreaterThan(2);
    expect(pts.map((p) => text.slice(0, p))).toContain('inter');
  });

  it('maps book offsets to drawn offsets and back', () => {
    const block: Block = { k: 'p', r: ['An ', ['international', 2], ' responsibility.'] };
    const d = drawn(block, look('en', '  '));
    const plain = 'An international responsibility.';
    expect(d.text.replace(/­/g, '')).toBe('  ' + plain);
    expect(d.hyphens.length).toBeGreaterThan(3);
    for (let o = 0; o <= plain.length; o++) {
      const i = toDrawn(d, o);
      // The drawn character at i is the book character at o.
      if (o < plain.length) expect(d.text[i]).toBe(plain[o]);
      expect(toBlock(d, i)).toBe(o);
    }
    // Styles survive the inserted hyphens.
    expect(d.runs.some((r) => Array.isArray(r) && r[1] === 2 && r[0].replace(/­/g, '') === 'international')).toBe(true);
  });

  it('leaves text untouched when off', () => {
    const block: Block = { k: 'p', r: ['international'] };
    const d = drawn(block, look(undefined));
    expect(d.text).toBe('international');
    expect(toDrawn(d, 5)).toBe(5);
  });
});

describe('text that looks like markup', () => {
  it('a "<" in a paragraph does not stop the rest of it being hyphenated', () => {
    const text = 'If x<y then everything afterwards needs hyphenation too';
    const at = text.indexOf('hyphenation');
    expect(hyphenPoints(text, 'en').filter((p) => p > at && p < at + 'hyphenation'.length).length).toBeGreaterThan(0);
    // The break points still line up with the text.
    expect(hyphenPoints('<<international>>', 'en').every((p) => p > 2 && p < 15)).toBe(true);
  });
});
