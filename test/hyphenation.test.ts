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
