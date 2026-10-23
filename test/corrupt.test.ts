// Damaged files: every byte-level corruption of a book must end in a manifest
// or an error, quickly. Never a hang, a crash of the test runner, or a buffer
// sized by a lie in the file (a ZIP entry claiming to be 4 GB).

import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { BookError } from '../src/engine/io';
import { MAX_ENTRY_BYTES, ZipArchive } from '../src/engine/zip';
import { MemorySource, enc, ingestBytes } from './helpers';
import { buildMobi } from './mobiFixture';

/** Small deterministic PRNG (mulberry32), so failures reproduce. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function epub() {
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8(
      '<package><metadata><dc:title>T</dc:title></metadata><manifest>' +
        '<item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="n" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>' +
        '</manifest><spine><itemref idref="a"/></spine></package>',
    ),
    'OEBPS/nav.xhtml': strToU8('<nav epub:type="toc"><ol><li><a href="a.xhtml#x">One</a></li></ol></nav>'),
    'OEBPS/a.xhtml': strToU8(`<html><body><h1 id="x">One</h1>${'<p>Some text of the chapter, and more.</p>'.repeat(200)}</body></html>`),
  });
}

const fb2 = () =>
  enc(`<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info><book-title>T</book-title></title-info></description>` +
    `<body><section><title><p>One</p></title>${'<p>Text <emphasis>here</emphasis>.</p>'.repeat(200)}</section></body></FictionBook>`);

const mobi = () => buildMobi({ title: 'T', html: `<html><body>${'<p>Paragraph of text.</p>'.repeat(300)}</body></html>` });

function mutate(bytes: Uint8Array, r: () => number): Uint8Array {
  const out = bytes.slice();
  const kind = r();
  if (kind < 0.6) {
    // flip a few bytes
    for (let n = 1 + Math.floor(r() * 8); n > 0; n--) out[Math.floor(r() * out.length)] = Math.floor(r() * 256);
    return out;
  }
  if (kind < 0.8) return out.subarray(0, Math.floor(r() * out.length)); // truncated download
  // a run of 0xFF: maxes out sizes and offsets
  const at = Math.floor(r() * out.length);
  out.fill(0xff, at, Math.min(out.length, at + 4 + Math.floor(r() * 8)));
  return out;
}

const CASES = 150;

describe.each([
  ['epub', epub, 'x.epub'],
  ['fb2', fb2, 'x.fb2'],
  ['mobi', mobi, 'x.mobi'],
])('corrupted %s', (_kind, make, name) => {
  it(`${CASES} random corruptions all end in a book or an error`, async () => {
    const good = make();
    const r = rng(name.length * 7919);
    for (let i = 0; i < CASES; i++) {
      const bad = mutate(good, r);
      const t0 = Date.now();
      await ingestBytes(bad, name).catch((e) => {
        expect(e).toBeInstanceOf(Error);
      });
      expect(Date.now() - t0, `case ${i} took too long`).toBeLessThan(3000);
    }
  }, 120_000);
});

/** Patch the central-directory size fields of one entry. */
function lieAboutSize(zip: Uint8Array, entry: string, size: number) {
  const out = zip.slice();
  const name = enc(entry);
  for (let p = 0; p + 46 < out.length; p++) {
    if (out[p] !== 0x50 || out[p + 1] !== 0x4b || out[p + 2] !== 1 || out[p + 3] !== 2) continue;
    const len = out[p + 28] | (out[p + 29] << 8);
    if (len === name.length && name.every((b, i) => out[p + 46 + i] === b)) {
      new DataView(out.buffer).setUint32(p + 24, size, true);
      return out;
    }
  }
  throw new Error('entry not found');
}

describe('ZIP entries that lie about their size', () => {
  it('a package file claiming to be 4 GB is refused, not allocated', async () => {
    const bad = lieAboutSize(epub(), 'OEBPS/content.opf', 0xfffffff0);
    const zip = ZipArchive.open(new MemorySource(bad));
    expect(() => zip.read(zip.find('OEBPS/content.opf')!)).toThrow(BookError);
    await expect(ingestBytes(bad, 'x.epub')).rejects.toBeInstanceOf(BookError);
  });

  it('a chapter that inflates far past its declared size (a zip bomb) is stopped', async () => {
    const bomb = zipSync(
      {
        mimetype: strToU8('application/epub+zip'),
        'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>'),
        'c.opf': strToU8('<package><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>'),
        'a.xhtml': new Uint8Array(8 * 1024 * 1024).fill(0x20),
      },
      { level: 9 },
    );
    // Declared as 1 KB, really 8 MB.
    const bad = lieAboutSize(bomb, 'a.xhtml', 1024);
    await expect(ingestBytes(bad, 'x.epub')).rejects.toBeInstanceOf(BookError);
  });

  it('real entries up to the limit still read', () => {
    expect(MAX_ENTRY_BYTES).toBeGreaterThanOrEqual(512 * 1024 * 1024);
    const zip = ZipArchive.open(new MemorySource(epub()));
    expect(new TextDecoder().decode(zip.read(zip.find('mimetype')!))).toBe('application/epub+zip');
  });
});

describe('hostile names never become file paths (zip-slip)', () => {
  it('images and covers are written under safe names only', async () => {
    const evil = '../../../library.json';
    const book = zipSync({
      mimetype: strToU8('application/epub+zip'),
      'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>'),
      'c.opf': strToU8(
        `<package><metadata><meta name="cover" content="cv"/></metadata><manifest><item id="cv" href="${evil}" media-type="image/png"/>` +
          '<item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>',
      ),
      'a.xhtml': strToU8(`<p>x<img src="${evil}"/><img src="/etc/passwd"/></p>`),
      [evil.replace(/^(\.\.\/)+/, '')]: Uint8Array.from([137, 80, 78, 71]),
    });
    const { manifest, sink } = await ingestBytes(book, 'x.epub');
    for (const n of sink.images.keys()) expect(n).toMatch(/^[A-Za-z0-9._-]+$/);
    for (const ref of Object.values(manifest.images)) if ('file' in ref) expect(ref.file).toMatch(/^[A-Za-z0-9._-]+$/);

    const fb = enc(
      '<FictionBook><body><section><p>x<image l:href="#../../evil"/></p></section></body>' +
        '<binary id="../../evil" content-type="image/png">iVBORw0KGgo=</binary></FictionBook>',
    );
    const r = await ingestBytes(fb, 'x.fb2');
    expect(r.sink.images.size).toBeGreaterThan(0);
    for (const n of r.sink.images.keys()) expect(n).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
