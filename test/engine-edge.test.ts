// Edge cases found in the pre-release audit; each failed before its fix.

import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ingestBook } from '../src/engine/ingest';
import { blockText } from '../src/engine/types';
import { MemorySink, MemorySource, enc, ingestBytes } from './helpers';
import { buildMobi } from './mobiFixture';

/** A minimal EPUB with the given chapters (file name -> XHTML) and nav entries. */
function epub(chapters: Record<string, string>, navLis = '') {
  const names = Object.keys(chapters);
  const items = names.map((n, i) => `<item id="c${i}" href="${encodeURI(n)}" media-type="application/xhtml+xml"/>`).join('');
  const spine = names.map((_, i) => `<itemref idref="c${i}"/>`).join('');
  const f: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8(
      `<package><metadata><dc:title>T</dc:title></metadata><manifest>${items}<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine>${spine}</spine></package>`,
    ),
    'OEBPS/nav.xhtml': strToU8(`<html><body><nav epub:type="toc"><ol>${navLis}</ol></nav></body></html>`),
  };
  for (const [n, html] of Object.entries(chapters)) f[`OEBPS/${n}`] = strToU8(html);
  return f;
}
const texts = (r: { blocks: Parameters<typeof blockText>[0][] }) => r.blocks.map(blockText);

describe('EPUB edge cases', () => {
  it('a Turkish İ before a <style> does not swallow the chapter', async () => {
    const r = await ingestBytes(
      zipSync(epub({ 'a.xhtml': '<html><head><title>İlk</title><style>p{}</style></head><body><p>Salam dünya</p></body></html>' })),
      'x.epub',
    );
    expect(texts(r)).toEqual(['Salam dünya']);
  });

  it('a namespaced <svg:style> ends where it should', async () => {
    const r = await ingestBytes(zipSync(epub({ 'a.xhtml': '<html><body><p>Before</p><svg:svg><svg:style>.a{}</svg:style></svg:svg><p>After</p></body></html>' })), 'x.epub');
    expect(texts(r)).toEqual(['Before', 'After']);
  });

  it('a huge data: URI image is skipped, not turned into text', async () => {
    const big = 'A'.repeat(200_000);
    const r = await ingestBytes(
      zipSync(epub({ 'a.xhtml': `<html><body><p>Before</p><p><img alt="x" src="data:image/png;base64,${big}"/></p><p>After</p></body></html>` }), { level: 0 }),
      'x.epub',
    );
    expect(texts(r)).toEqual(['Before', 'After']);
  });

  it('reads UTF-8 file names written without the UTF-8 flag', async () => {
    const z = zipSync(epub({ 'Глава.xhtml': '<p>Привет</p>' }));
    for (let i = 0; i + 10 < z.length; i++) {
      if (z[i] === 0x50 && z[i + 1] === 0x4b && z[i + 2] === 3 && z[i + 3] === 4) z[i + 7] &= ~0x08;
      if (z[i] === 0x50 && z[i + 1] === 0x4b && z[i + 2] === 1 && z[i + 3] === 2) z[i + 9] &= ~0x08;
    }
    expect(texts(await ingestBytes(z, 'x.epub'))).toEqual(['Привет']);
  });

  it('a TOC anchor on a heading after loose text points at the heading', async () => {
    const r = await ingestBytes(
      zipSync(epub({ 'a.xhtml': '<html><body><div>Loose intro text<h2 id="c2">Chapter Two</h2><p>Body</p></div></body></html>' }, '<li><a href="a.xhtml#c2">Chapter Two</a></li>')),
      'x.epub',
    );
    const b = r.manifest.toc.find((t) => t.t === 'Chapter Two')!.b;
    expect(blockText(r.blocks[b])).toBe('Chapter Two');
  });

  it('percent-encoded fragments find their ids', async () => {
    const r = await ingestBytes(
      zipSync(epub({ 'a.xhtml': '<html><body><p>One</p><p>Two</p><h2 id="гл1">Глава</h2><p>Text</p></body></html>' }, '<li><a href="a.xhtml#%D0%B3%D0%BB1">Глава</a></li>')),
      'x.epub',
    );
    const b = r.manifest.toc.find((t) => t.t === 'Глава')!.b;
    expect(blockText(r.blocks[b])).toBe('Глава');
  });
});

describe('FB2 notes', () => {
  it('footnotes are neither TOC entries nor separate chapters', async () => {
    const notes = [1, 2, 3, 4, 5].map((n) => `<section id="n${n}"><title><p>${n}</p></title><p>Note ${n}</p></section>`).join('');
    const xml = `<?xml version="1.0" encoding="utf-8"?><FictionBook><body><section><title><p>Chapter</p></title><p>Text<a l:href="#n1" type="note">1</a></p></section></body><body name="notes"><title><p>Notes</p></title>${notes}</body></FictionBook>`;
    const r = await ingestBytes(enc(xml), 'b.fb2');
    expect(r.manifest.toc.map((t) => t.t)).toEqual(['Chapter', 'Notes']);
    expect(r.manifest.chunks.length).toBeLessThanOrEqual(2);
    expect(r.manifest.notes?.['#n1']).toBeDefined();
  });
});

describe('FB2 pictures', () => {
  // Its base64 is cleaned a slice at a time as it arrives, not all at once at
  // its end; how long the longest slice takes is measured by the stress
  // benchmark (bench/), not here: a timing in a unit test fails on a busy machine.
  it('a big picture comes through whole, cleaned of line breaks', async () => {
    const line = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2\n';
    const b64 = line.repeat(300_000); // ~20 MB
    const xml = enc(`<?xml version="1.0" encoding="utf-8"?><FictionBook><body><section><p>Text.</p></section></body><binary id="big" content-type="image/jpeg">${b64}</binary></FictionBook>`);
    const sink = new MemorySink();
    await ingestBook({ src: new MemorySource(xml), sink, progress() {}, fallbackTitle: 'b', pause: async () => {} }, 'b.fb2');
    expect(sink.images.get('b_big.jpg')).toBe(b64.replace(/\n/g, ''));
  });
});

describe('TXT headings', () => {
  it('sentences starting with Part/Book stay paragraphs; real headings are found', async () => {
    const txt = 'He was tired.\nPart of me wanted to stay.\nBook me a flight, she said.\nChapter 12\nThe end came.\nPart II: The Return\nГлава первая\n';
    const r = await ingestBytes(enc(txt), 'a.txt');
    expect(r.manifest.toc.map((t) => t.t)).toEqual(['Chapter 12', 'Part II: The Return', 'Глава первая']);
  });

  it('a text with no name (shared under an id) is titled by its first line', async () => {
    const r = await ingestBytes(enc('\n  The Old Man and the Sea  \n\nHe was an old man who fished alone.\n'), 'Untitled');
    expect(r.manifest.title).toBe('The Old Man and the Sea');
    const long = await ingestBytes(enc('It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness.\n'), 'Untitled');
    expect(long.manifest.title).toBe('It was the best of times, it was the worst of times, it was…');
    // A real name is kept.
    expect((await ingestBytes(enc('First line.\n'), 'Notes from Underground')).manifest.title).toBe('Notes from Underground');
  });

  it('a long run without spaces never splits an emoji in half', async () => {
    const r = await ingestBytes(enc('a' + '😀'.repeat(5000)), 'e.txt');
    for (const t of texts(r)) {
      expect(/^[\uDC00-\uDFFF]/.test(t)).toBe(false);
      expect(/[\uD800-\uDBFF]$/.test(t)).toBe(false);
    }
  });
});

describe('PalmDOC text', () => {
  it('keeps paragraph breaks and treats < and & as text', async () => {
    const book = buildMobi({ html: 'Line one & more\nLine two <b>\n\nSecond para here.', title: 'Plain', compression: 1 });
    // Make it a plain PalmDOC file: type TEXtREAd, no MOBI header.
    book.set(enc('TEXtREAd'), 60);
    const rec0 = (book[78] << 24) | (book[79] << 16) | (book[80] << 8) | book[81];
    book.set(enc('XXXX'), rec0 + 16);
    const r = await ingestBytes(book, 'plain.pdb');
    expect(texts(r)).toEqual(['Line one & more', 'Line two <b>', 'Second para here.']);
  });
});
