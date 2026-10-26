import { describe, expect, it } from 'vitest';
import { fold } from '@/engine/fold';

describe('folding text for matching', () => {
  it('ignores capitals and the Turkish dotted and dotless i', () => {
    for (const w of ['IŞIK', 'Işık', 'ışık', 'işik']) expect(fold(w)).toBe('isik');
    expect(fold('İstanbul')).toBe(fold('istanbul'));
    expect(fold('KAPI')).toBe(fold('kapı'));
    expect(fold('ILIK RÜZGÂR')).toBe('ilik ruzgar');
  });

  it('ignores accents', () => {
    expect(fold('Kırmızı güneş')).toBe('kirmizi gunes');
    expect(fold('Çöl ağacı')).toBe('col agaci');
    expect(fold('café crème')).toBe('cafe creme');
    expect(fold('Ёлка')).toBe('елка');
  });

  it('keeps the length, so offsets in the folded text are offsets in the original', () => {
    for (const s of ['İİİ', 'Straße ẞ', 'Ǆemal', 'emoji 📚 here', 'Iıİi', 'ﬁne']) expect(fold(s).length).toBe(s.length);
    const text = 'Eski İstanbul ışıkları';
    const at = fold(text).indexOf(fold('ISIKLARI'));
    expect(text.slice(at, at + 'ISIKLARI'.length)).toBe('ışıkları');
  });

  it('leaves plain lower-case text as it is', () => {
    expect(fold('call me ishmael, 1851.')).toBe('call me ishmael, 1851.');
  });
});
