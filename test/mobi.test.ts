import { describe, expect, it } from 'vitest';
import { DRM_MESSAGE } from '../src/engine/io';
import { palmdocDecompress, trailingSize } from '../src/engine/mobi';
import { blockText } from '../src/engine/types';
import { ingestBytes } from './helpers';
import { buildMobi, fakeJpeg, palmdocCompress } from './mobiFixture';

const longText = Array.from({ length: 400 }, (_, i) => `<p>Paragraph ${i}: the quick brown fox — Съешь же ещё этих мягких булок ${i % 7}.</p>`).join('');

describe('MOBI internals', () => {
  it('round-trips PalmDOC compression', () => {
    const bytes = new TextEncoder().encode('Hello hello hello world! Привет, мир. ' + 'abcabcabcabc'.repeat(30));
    const packed = palmdocCompress(bytes);
    expect(packed.length).toBeLessThan(bytes.length);
    expect(palmdocDecompress(packed)).toEqual(bytes);
  });

  it('measures trailing entries', () => {
    expect(trailingSize(Uint8Array.from([1, 2, 3, 0x00, 0x81]), 3)).toBe(2);
    expect(trailingSize(Uint8Array.from([1, 2, 3, 0x02]), 1)).toBe(3);
    expect(trailingSize(Uint8Array.from([1, 2, 3]), 0)).toBe(0);
  });
});

describe('MOBI books', () => {
  it('reads a compressed KF7 book with metadata, page breaks, images and cover', async () => {
    const html =
      '<html><head><guide></guide></head><body><h1>Chapter One</h1><p>Hello <b>bold</b> world.</p>' +
      '<p><img recindex="00002" /></p><mbp:pagebreak/><h2>Chapter Two</h2>' +
      longText +
      '</body></html>';
    const file = buildMobi({ html, title: 'Test Book', author: 'Jane Doe', lang: 'en', images: [fakeJpeg(1), fakeJpeg(2)], cover: 0, trailing: true });
    const { manifest, blocks, sink } = await ingestBytes(file, 'test.mobi');
    expect(manifest.format).toBe('mobi');
    expect(manifest.title).toBe('Test Book');
    expect(manifest.author).toBe('Jane Doe');
    expect(manifest.lang).toBe('en');
    const texts = blocks.map((b) => (b.k === 'img' ? `img:${b.s}` : blockText(b)));
    expect(texts.slice(0, 4)).toEqual(['Chapter One', 'Hello bold world.', expect.stringMatching(/^img:rec:/), 'Chapter Two']);
    expect(texts).toContain('Paragraph 399: the quick brown fox — Съешь же ещё этих мягких булок 0.');
    expect(texts.filter((t) => t.startsWith('Paragraph ')).length).toBe(400);
    expect(manifest.toc.map((t) => t.t)).toEqual(['Chapter One', 'Chapter Two']);
    const img = manifest.images[blocks[2].s!];
    expect(img).toMatchObject({ ext: 'jpg' });
    expect(manifest.cover).toBe('__cover');
    expect(sink.images.has('cover.jpg')).toBe(true);
    // The page break started a new chunk for chapter two.
    expect(manifest.chunks.some(([b]) => b === 3)).toBe(true);
  });

  it('reads an uncompressed book without trailing data', async () => {
    const file = buildMobi({ html: '<p>Plain text.</p>', title: 'Plain', compression: 1 });
    const { blocks } = await ingestBytes(file, 'plain.prc');
    expect(blocks.map(blockText)).toEqual(['Plain text.']);
  });

  it('reads a KF8 (AZW3) book and stops before the stylesheet flow', async () => {
    const skeleton = '<?xml version="1.0"?><html><head><title>T</title><link href="kindle:flow:0001?mime=text/css"/></head><body aid="0"></body></html>';
    const fragments = '<div aid="1"><h1>Start</h1><p>KF8 text <img src="kindle:embed:0001?mime=image/jpeg"/></p></div><div aid="2"><p>More.</p></div>';
    const file = buildMobi({ html: skeleton + fragments, extraFlow: 'p { margin: 0 } .x { color: red }', title: 'KF8 Book', kf8: true, images: [fakeJpeg(3)] });
    const { manifest, blocks } = await ingestBytes(file, 'book.azw3');
    expect(manifest.format).toBe('azw3');
    expect(blocks.map((b) => (b.k === 'img' ? 'img' : blockText(b)))).toEqual(['Start', 'KF8 text', 'img', 'More.']);
  });

  it('refuses DRM-protected books with a clear message', async () => {
    const file = buildMobi({ html: '<p>x</p>', title: 'Locked', encryption: 2 });
    // The same words as for a copy-protected EPUB.
    await expect(ingestBytes(file, 'locked.azw')).rejects.toThrow(DRM_MESSAGE);
  });
});
