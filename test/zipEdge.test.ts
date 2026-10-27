// ZIP files as tools really write them: an archive comment holding what looks
// like the end record, entries packed in ways the app can't unpack, Windows
// folder separators, an entry claiming to run past the end of the file; and
// compressed chapters read in slices small enough to keep the app responsive.

import { deflateSync, strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ingestBook } from '../src/engine/ingest';
import { BookError } from '../src/engine/io';
import { ZipArchive } from '../src/engine/zip';
import { MemorySink, MemorySource, ingestBytes } from './helpers';

interface Entry {
  name: string;
  data: string | Uint8Array;
  method?: number;
  flags?: number;
  /** The size of its packed data the central directory gives (a damaged file's lie), if not the real one. */
  claims?: number;
}

/** A ZIP written by hand, so method and flags can be anything. */
function buildZip(files: Entry[], comment = new Uint8Array(0)) {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = typeof f.data === 'string' ? strToU8(f.data) : f.data;
    const method = f.method ?? 8;
    const data = method === 8 ? deflateSync(raw) : raw;
    const name = strToU8(f.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, f.flags ?? 0, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(8, f.flags ?? 0, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, f.claims ?? data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    parts.push(local, data);
    central.push(cd);
    offset += local.length + data.length;
  }
  const cdLen = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22 + comment.length);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdLen, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, comment.length, true);
  end.set(comment, 22);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const epubEntries = (chapter: Partial<Entry> = {}, sep = '/'): Entry[] => [
  { name: 'mimetype', data: 'application/epub+zip', method: 0 },
  { name: `META-INF${sep}container.xml`, data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
  { name: `OEBPS${sep}content.opf`, data: '<package><metadata><dc:title>Z</dc:title></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>' },
  { name: `OEBPS${sep}c.xhtml`, data: '<html><body><p>Hello zip world.</p></body></html>', ...chapter },
];
const textOf = async (zip: Uint8Array) => (await ingestBytes(zip, 'z.epub')).blocks.map((b) => b.r?.join(''));

describe('ZIP files', () => {
  it('an archive comment that contains the end record’s signature', async () => {
    const comment = Uint8Array.from([0x50, 0x4b, 0x05, 0x06, ...new Array(30).fill(0x41)]);
    expect(await textOf(buildZip(epubEntries(), comment))).toEqual(['Hello zip world.']);
  });

  it('folders separated by backslashes', async () => {
    expect(await textOf(buildZip(epubEntries({}, '\\')))).toEqual(['Hello zip world.']);
  });

  it('entries the app can’t unpack say why', async () => {
    const why = async (chapter: Partial<Entry>) => {
      const e = await ingestBytes(buildZip(epubEntries(chapter)), 'z.epub').catch((x) => x);
      expect(e).toBeInstanceOf(BookError);
      return (e as Error).message;
    };
    expect(await why({ flags: 1 })).toMatch(/locked with a password/);
    expect(await why({ method: 99 })).toMatch(/locked with a password/);
    expect(await why({ method: 9 })).toMatch(/Deflate64/);
    expect(await why({ method: 14 })).toMatch(/LZMA/);
  });

  it('compressed chapters are inflated a quarter slice at a time', async () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    const words = Array.from({ length: 400_000 }, () => String.fromCharCode(97 + Math.floor(rnd() * 26)).repeat(1 + Math.floor(rnd() * 8))).join(' ');
    const zip = ZipArchive.open(new MemorySource(zipSync({ 'a.txt': strToU8(words) })));
    const e = zip.find('a.txt')!;
    let slices = 0;
    let biggest = 0;
    await zip.stream(
      e,
      (b) => (biggest = Math.max(biggest, b.length)),
      async () => {
        slices++;
      },
    );
    expect(slices).toBe(Math.ceil(e.compressedSize / (16 * 1024)));
    expect(biggest).toBeLessThan(160 * 1024);
  });

  it('an entry claiming to run 2 GB past the end of the file is read to where the file ends, as if cut there', async () => {
    for (const method of [0, 8]) {
      const file = new MemorySource(buildZip(epubEntries({ method, claims: 0x7ffffff0 })));
      let reads = 0;
      const src = {
        size: file.size,
        read(offset: number, length: number) {
          reads++;
          return file.read(offset, length);
        },
      };
      const sink = new MemorySink();
      const manifest = await ingestBook({ src, sink, progress() {}, pause: async () => {}, fallbackTitle: 'z' }, 'z.epub');
      // The book still converts, from what is there.
      expect(manifest.totalBlocks).toBeGreaterThan(0);
      expect(sink.blocks()[0].r?.join('')).toBe('Hello zip world.');
      // Read on to the 2 GB it claims, it took 33,000 reads of nothing (130,000 compressed), with a pause after each.
      expect(reads, `method ${method}`).toBeLessThan(50);
    }
  });

  it('reads just the start of an entry', () => {
    const zip = ZipArchive.open(new MemorySource(zipSync({ 'big.bin': new Uint8Array(1_000_000).fill(7), 'stored.bin': [new Uint8Array(50_000).fill(9), { level: 0 }] })));
    expect(zip.head(zip.find('big.bin')!, 1000)).toEqual(new Uint8Array(1000).fill(7));
    expect(zip.head(zip.find('stored.bin')!, 10)).toEqual(new Uint8Array(10).fill(9));
  });
});
