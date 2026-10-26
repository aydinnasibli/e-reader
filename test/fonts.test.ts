// Every reading font bundled with the app draws all the Turkish letters
// itself: a missing one (the first Atkinson Hyperlegible has no capital İ) is
// drawn by another font, mid-word. Reads each font file that src/lib/fonts.ts
// loads and looks the letters up in its character map.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const TURKISH = 'çÇğĞıİöÖşŞüÜâÂîÎûÛ';

/** The font files fonts.ts loads (its require() calls). */
function bundledFonts(): string[] {
  const src = readFileSync(join(ROOT, 'src/lib/fonts.ts'), 'utf8');
  return [...src.matchAll(/require\('([^']+\.ttf)'\)/g)].map((m) => m[1]);
}

/** The characters a TrueType/OpenType font has glyphs for (cmap formats 4 and 12). */
function characters(file: string): Set<number> {
  const d = readFileSync(file);
  const tables = d.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < tables; i++) if (d.toString('latin1', 12 + 16 * i, 16 + 16 * i) === 'cmap') cmap = d.readUInt32BE(20 + 16 * i);
  const chars = new Set<number>();
  const subtables = d.readUInt16BE(cmap + 2);
  for (let i = 0; i < subtables; i++) {
    const at = cmap + d.readUInt32BE(cmap + 8 + 8 * i);
    const format = d.readUInt16BE(at);
    if (format === 4) {
      const segs = d.readUInt16BE(at + 6) / 2;
      const ends = at + 14;
      const starts = ends + 2 * segs + 2;
      const deltas = starts + 2 * segs;
      const ranges = deltas + 2 * segs;
      for (let s = 0; s < segs; s++) {
        const start = d.readUInt16BE(starts + 2 * s);
        const end = d.readUInt16BE(ends + 2 * s);
        const delta = d.readInt16BE(deltas + 2 * s);
        const range = d.readUInt16BE(ranges + 2 * s);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          const glyph = range ? d.readUInt16BE(ranges + 2 * s + range + 2 * (c - start)) : c;
          if (glyph && (glyph + delta) & 0xffff) chars.add(c);
        }
      }
    } else if (format === 12) {
      const groups = d.readUInt32BE(at + 12);
      for (let g = 0; g < groups; g++) {
        for (let c = d.readUInt32BE(at + 16 + 12 * g); c <= d.readUInt32BE(at + 20 + 12 * g); c++) chars.add(c);
      }
    }
  }
  return chars;
}

describe('bundled reading fonts', () => {
  const files = bundledFonts();

  it('are found in fonts.ts', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files)('%s has every Turkish letter', (file) => {
    const chars = characters(join(ROOT, 'node_modules', file));
    expect([...TURKISH].filter((ch) => !chars.has(ch.codePointAt(0)!)).join('')).toBe('');
  });

  it('Atkinson is the Next edition (the first one has no İ), with a medium weight', () => {
    const atkinson = files.filter((f) => f.includes('atkinson'));
    expect(atkinson.length).toBe(6);
    expect(atkinson.every((f) => f.startsWith('@expo-google-fonts/atkinson-hyperlegible-next/'))).toBe(true);
  });
});
