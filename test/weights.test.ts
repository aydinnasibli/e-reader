// Chunk weights: how much page space each chunk takes, in lines, so that page
// numbers estimated from them barely drift between chunks of different kinds
// (prose, a contents list of short lines, pictures). Reported per chunk while
// converting and kept in the manifest.

import { describe, expect, it } from 'vitest';
import { pictureSize } from '../src/engine/picture';
import { blockWeight, pictureLines } from '../src/engine/writer';
import { buildMobi, fakeJpeg } from './mobiFixture';
import { ingestBook } from '../src/engine/ingest';
import { MemorySink, MemorySource, enc, ingestBytes, makeEpub, xhtml } from './helpers';

/** A JPEG header saying the picture is w × h. */
function jpegOf(w: number, h: number) {
  const b = new Uint8Array(400);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3], 20);
  return b;
}

describe('chunk weights', () => {
  it('one per chunk, the same while converting as in the manifest, for every format', async () => {
    const prose = Array.from({ length: 400 }, (_, i) => `<p>Paragraph ${i} of a book, with enough words in it to fill a line or two of a phone screen.</p>`).join('');
    const books = [
      await ingestBytes(makeEpub({ chapters: { 'a.xhtml': xhtml(prose), 'b.xhtml': xhtml(prose) } }), 'x.epub'),
      await ingestBytes(enc(Array.from({ length: 2000 }, (_, i) => `Line ${i} of a plain text book, one paragraph a line.`).join('\n')), 'x.txt'),
      await ingestBytes(enc(`<?xml version="1.0" encoding="utf-8"?><FictionBook><body><section>${'<p>Text of a paragraph here.</p>'.repeat(3000)}</section></body></FictionBook>`), 'x.fb2'),
      await ingestBytes(buildMobi({ html: `<html><body>${prose}</body></html>`, title: 'M' }), 'x.mobi'),
    ];
    for (const r of books) {
      const { weights, chunks } = r.manifest;
      expect(weights).toHaveLength(chunks.length);
      expect(r.sink.infos.map((i) => i.weight)).toEqual(weights);
      expect(weights!.every((w) => Number.isInteger(w) && w >= 1)).toBe(true);
    }
  });

  it('a contents list of short lines weighs far more per character than prose', async () => {
    const list = Array.from({ length: 300 }, (_, i) => `<p><a href="b.xhtml">Chapter ${i + 1}</a></p>`).join('');
    const prose = `<p>${'All happy families are alike; each unhappy family is unhappy in its own way. '.repeat(50)}</p>`;
    const r = await ingestBytes(makeEpub({ chapters: { 'toc.xhtml': xhtml(list), 'b.xhtml': xhtml(prose) } }), 'x.epub');
    const [tocW, proseW] = r.manifest.weights!;
    const chars = (c: number) => (c + 1 < r.manifest.chunks.length ? r.manifest.chunks[c + 1][1] : r.manifest.totalChars) - r.manifest.chunks[c][1];
    // Every entry takes a line of its own; the prose fills its lines.
    expect(tocW).toBeGreaterThanOrEqual(300);
    expect(tocW / chars(0)).toBeGreaterThan((2.5 * proseW) / chars(1));
  });

  it('headings, empty lines and separators take their room', () => {
    expect(blockWeight({ k: 'h', l: 1, r: ['Chapter One'] })).toBeGreaterThan(3);
    expect(blockWeight({ k: 'sp' })).toBe(1);
    expect(blockWeight({ k: 'hr' })).toBe(1);
    expect(blockWeight({ k: 'p', r: ['x'.repeat(360)] })).toBe(10);
    // Verse: every line counts, however short.
    expect(blockWeight({ k: 'v', r: ['One\nTwo\nThree'] })).toBe(3);
  });

  it('a picture weighs what it covers: a plate most of a page, an ornament a line or two', async () => {
    expect(pictureSize(jpegOf(1200, 1800))).toEqual([1200, 1800]);
    expect(pictureSize(fakeJpeg(1))).toBeNull();
    // Shown a column (340 px) wide, at most a page (680 px) high, in lines of 29 px.
    expect(pictureLines(1200, 1800)).toBeCloseTo(510 / 29);
    expect(pictureLines(1000, 3000)).toBeCloseTo(680 / 29);
    expect(pictureLines(100, 40)).toBeLessThan(2);
    const r = await ingestBytes(
      makeEpub({
        chapters: { 'a.xhtml': xhtml('<p><img src="plate.jpg"/></p>'), 'b.xhtml': xhtml('<p><img src="dot.jpg"/></p>'), 'c.xhtml': xhtml('<p><img src="unknown.jpg"/></p>') },
        files: { 'OEBPS/plate.jpg': jpegOf(1200, 1800), 'OEBPS/dot.jpg': jpegOf(100, 40), 'OEBPS/unknown.jpg': fakeJpeg(2) },
      }),
      'x.epub',
    );
    expect(r.manifest.weights).toEqual([18, 1, 12]);
  });
});

describe('reading picture sizes', () => {
  it('only so much is read between two pauses: a chapter of 100 photos', async () => {
    // A JPEG whose size (SOF0, 800×600) comes after 30 KB of metadata, as with EXIF thumbnails or XMP.
    let s = 1;
    const noise = (n: number) => Uint8Array.from({ length: n }, () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) >> 16) & 0xff);
    const jpeg = () => {
      const app = 30_000;
      return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, ((app + 2) >> 8) & 0xff, (app + 2) & 0xff, ...noise(app), 0xff, 0xc0, 0, 17, 8, 2, 0x58, 3, 0x20, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, ...noise(20_000), 0xff, 0xd9]);
    };
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 100; i++) files[`OEBPS/i${i}.jpg`] = jpeg();
    const body = Array.from({ length: 100 }, (_, i) => `<p><img src="i${i}.jpg" alt=""/></p>`).join('');
    const src = new MemorySource(makeEpub({ chapters: { 'c.xhtml': xhtml(body) }, files }));
    let since = 0;
    let most = 0;
    const counting = {
      get size() {
        return src.size;
      },
      read: (o: number, l: number) => {
        const b = src.read(o, l);
        since += b.length;
        most = Math.max(most, since);
        return b;
      },
    };
    const m = await ingestBook({ src: counting, sink: new MemorySink(), progress() {}, pause: async () => void (since = 0), fallbackTitle: 'b' }, 'b.epub');
    // (It was 2.2 MB, 6.6 MB inflated, with no pause: under Hermes 300 such photos froze the app for 2.4 s.)
    expect(most).toBeLessThan(256 * 1024);
    expect(m.totalBlocks).toBe(100);
  });
});
