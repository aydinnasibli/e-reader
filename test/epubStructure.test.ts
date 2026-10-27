// EPUB structure the converter used to get wrong: what's in the spine, how
// contents and covers are found, links back from notes, file names written
// by macOS, and books with nothing in them.

import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { blockText } from '../src/engine/types';
import { ingestBytes, makeEpub, xhtml } from './helpers';

const jpeg = (n = 3000) => {
  const b = new Uint8Array(n);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  for (let i = 4; i < n; i++) b[i] = (i * 7919) & 0xff;
  return b;
};
const shown = (r: Awaited<ReturnType<typeof ingestBytes>>) => r.blocks.map((b) => (b.k === 'img' ? `[img ${b.s}]` : blockText(b)));

describe('the spine', () => {
  it('a picture in the spine is a picture page, not pages of binary text', async () => {
    const r = await ingestBytes(
      makeEpub({ chapters: { 'c1.xhtml': xhtml('<p>Text page</p>') }, items: '<item id="pg" href="images/p1.jpg" media-type="image/jpeg"/>', spine: ['c0', 'pg'], files: { 'OEBPS/images/p1.jpg': jpeg() } }),
      'x.epub',
    );
    expect(shown(r)).toEqual(['Text page', '[img OEBPS/images/p1.jpg]']);
  });

  it('an SVG page shows its picture, not its title or description; a stylesheet in the spine shows nothing', async () => {
    const svg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><title>Cover</title><desc>A drawing of a ship</desc><image width="600" height="800" xlink:href="images/cover.jpg"/></svg>';
    const r = await ingestBytes(
      makeEpub({
        chapters: { 'c1.xhtml': xhtml('<p>Text</p>') },
        items: '<item id="sv" href="cover.svg" media-type="image/svg+xml"/><item id="st" href="style.css" media-type="text/css"/>',
        spine: ['sv', 'st', 'c0'],
        files: { 'OEBPS/cover.svg': svg, 'OEBPS/images/cover.jpg': jpeg(), 'OEBPS/style.css': 'p { color: red }' },
      }),
      'x.epub',
    );
    expect(shown(r)).toEqual(['[img OEBPS/images/cover.jpg]', 'Text']);
  });

  it('a book with nothing to show is refused with a clear message', async () => {
    const empty = zipSync({
      mimetype: strToU8('application/epub+zip'),
      'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>'),
      'c.opf': strToU8('<package><metadata><dc:title>Empty</dc:title></metadata><manifest/><spine/></package>'),
    });
    await expect(ingestBytes(empty, 'x.epub')).rejects.toThrow(/empty/);
  });
});

describe('contents', () => {
  it('entries whose link differs from the file only in case, or uses ./ and ..', async () => {
    const r = await ingestBytes(
      makeEpub({
        chapters: { 'Text/Chapter1.xhtml': xhtml('<h1>One</h1><p>a</p>'), 'Text/ch2.xhtml': xhtml('<h1>Two</h1><p>b</p>'), 'Text/ch3.xhtml': xhtml('<h1>Three</h1>') },
        nav: '<nav epub:type="toc"><ol><li><a href="text/chapter1.xhtml">One</a></li><li><a href="Text/CH2.xhtml">Two</a></li><li><a href="./Text/../Text/ch3.xhtml">Three</a></li></ol></nav>',
      }),
      'x.epub',
    );
    expect(r.manifest.toc).toEqual([
      { t: 'One', l: 0, b: 0 },
      { t: 'Two', l: 0, b: 2 },
      { t: 'Three', l: 0, b: 4 },
    ]);
  });

  it('a nav whose type has another namespace prefix (ops:type) or a doc-toc role', async () => {
    for (const nav of ['<nav xmlns:ops="http://www.idpf.org/2007/ops" ops:type="toc">', '<nav role="doc-toc">']) {
      const r = await ingestBytes(
        makeEpub({ chapters: { 'a.xhtml': xhtml('<h2>Part A</h2><p>x</p>'), 'b.xhtml': xhtml('<h2>Part B</h2>') }, nav: `${nav}<ol><li><a href="a.xhtml">Real title A</a></li><li><a href="b.xhtml">Real title B</a></li></ol></nav>` }),
        'x.epub',
      );
      expect(r.manifest.toc.map((t) => t.t)).toEqual(['Real title A', 'Real title B']);
    }
  });
});

describe('covers', () => {
  const cases: [string, string, string, string?][] = [
    ['the metadata naming the picture by its path', '<dc:title>T</dc:title><meta name="cover" content="images/cover.jpg"/>', '<item id="img1" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>'],
    ['the metadata naming an id that isn’t there', '<dc:title>T</dc:title><meta name="cover" content="missing"/>', '<item id="ci" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>'],
    ['the metadata naming the cover page', '<dc:title>T</dc:title><meta name="cover" content="cp"/>', '<item id="cp" href="cover.xhtml" media-type="application/xhtml+xml"/>'],
    ['only the guide', '<dc:title>T</dc:title>', '<item id="cp" href="cover.xhtml" media-type="application/xhtml+xml"/>', '<reference type="cover" href="cover.xhtml" title="Cover"/>'],
    ['only a picture called cover', '<dc:title>T</dc:title>', '<item id="pic" href="images/cover.jpg" media-type="image/jpeg"/>'],
  ];
  for (const [label, metadata, items, guide] of cases) {
    it(`found from ${label}`, async () => {
      const r = await ingestBytes(
        makeEpub({ chapters: { 'a.xhtml': xhtml('<p>x</p>') }, metadata, items, guide, files: { 'OEBPS/images/cover.jpg': jpeg(), 'OEBPS/cover.xhtml': xhtml('<div><img src="images/cover.jpg" alt="Cover"/></div>') } }),
        'x.epub',
      );
      expect(r.manifest.cover).toBe('__cover');
      expect(r.sink.images.has('cover.jpg')).toBe(true);
    });
  }

  it('else the picture on a first page that is little more than that picture', async () => {
    const r = await ingestBytes(
      makeEpub({ chapters: { 'cover.xhtml': xhtml('<p><img src="art.png"/></p>'), 'a.xhtml': xhtml('<p>Text</p>') }, files: { 'OEBPS/art.png': Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) } }),
      'x.epub',
    );
    expect(r.manifest.cover).toBe('__cover');
    const chapterFirst = await ingestBytes(makeEpub({ chapters: { 'a.xhtml': xhtml(`<p>${'Chapter text. '.repeat(40)}<img src="art.png"/></p>`) }, files: { 'OEBPS/art.png': Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) } }), 'x.epub');
    expect(chapterFirst.manifest.cover).toBeUndefined();
  });
});

describe('authors', () => {
  const author = async (metadata: string) => (await ingestBytes(makeEpub({ chapters: { 'a.xhtml': xhtml('<p>x</p>') }, metadata: `<dc:title>T</dc:title>${metadata}` }), 'x.epub')).manifest.author;

  it('a translator or illustrator listed as a creator isn’t an author (EPUB 2 opf:role)', async () => {
    expect(await author('<dc:creator opf:role="aut">Fyodor Dostoyevski</dc:creator><dc:creator opf:role="trl">Mehmet Özgül</dc:creator><dc:creator opf:role="ill">Ayşe Kaya</dc:creator>')).toBe('Fyodor Dostoyevski');
  });

  it('nor when the roles are given apart, by id (EPUB 3 <meta refines>); a creator given no role stays', async () => {
    const metadata =
      '<dc:creator id="c1">Orhan Pamuk</dc:creator><dc:creator id="c2">Maureen Freely</dc:creator><dc:creator>Second Author</dc:creator>' +
      '<meta refines="#c1" property="role" scheme="marc:relators">aut</meta><meta refines="#c2" property="role" scheme="marc:relators">trl</meta>';
    expect(await author(metadata)).toBe('Orhan Pamuk, Second Author');
  });

  it('when no creator is named an author, all of them are listed, as before', async () => {
    expect(await author('<dc:creator>A. Writer</dc:creator><dc:creator opf:role="edt">B. Editor</dc:creator>')).toBe('A. Writer, B. Editor');
  });
});

describe('links', () => {
  it('a note’s link back to its reference goes to the reference (an anchor, not a note)', async () => {
    const r = await ingestBytes(
      makeEpub({
        chapters: {
          'a.xhtml': xhtml('<p>Before.</p><p id="ref1">Text<a href="notes.xhtml#fn1">1</a> goes on.</p>'),
          'notes.xhtml': xhtml('<p id="fn1"><a href="a.xhtml#ref1">1.</a> The note.</p>'),
        },
      }),
      'x.epub',
    );
    expect(r.manifest.notes?.['OEBPS/notes.xhtml#fn1']).toBeDefined();
    expect(r.manifest.anchors?.['OEBPS/a.xhtml#ref1']).toBe(1);
    // (At the start of its block: not listed among the offsets.)
    expect(r.manifest.anchorOffsets).toEqual({});
    expect(r.manifest.notes?.['OEBPS/a.xhtml#ref1']).toBeUndefined();
  });

  it('a link back to a note’s mark inside a paragraph lands on the mark: its block, and where in it the mark is', async () => {
    const r = await ingestBytes(
      makeEpub({
        chapters: {
          'a.xhtml': xhtml(
            '<p>Text<a id="r1" href="notes.xhtml#n1">1</a> goes on.</p>' +
              '<p>Many words, <a id="r2" href="notes.xhtml#n2"><sup>2</sup></a> and on.</p>' +
              // Past where this long paragraph is split for speed (the mark comes before the split is made).
              `<p>${'word '.repeat(560)}there<a id="r3" href="notes.xhtml#n3">3</a> ${'more '.repeat(200)}at last.</p>` +
              '<p>Old style<a name="r4"></a> <a href="notes.xhtml#n4">[4]</a> here.</p>' +
              '<pre>\n   code<a id="r5" href="notes.xhtml#n5">5</a></pre>' +
              '<p id="r6">Whole paragraph<a href="notes.xhtml#n6">6</a>.</p>',
          ),
          'notes.xhtml': xhtml([1, 2, 3, 4, 5, 6].map((n) => `<p id="n${n}"><a href="a.xhtml#r${n}">${n}.</a> Note ${n}.</p>`).join('')),
        },
      }),
      'x.epub',
    );
    const { anchors = {}, anchorOffsets = {} } = r.manifest;
    const from = (id: string) => blockText(r.blocks[anchors[`OEBPS/a.xhtml#${id}`]]).slice(anchorOffsets[`OEBPS/a.xhtml#${id}`] ?? 0);
    expect(from('r1')).toBe('1 goes on.');
    expect(from('r2')).toBe('2 and on.');
    expect(from('r3')).toMatch(/^3 more more /);
    expect(r.blocks[anchors['OEBPS/a.xhtml#r3']].c).toBe(1);
    expect(from('r4')).toBe('[4] here.');
    expect(from('r5')).toBe('5');
    // At the start of its block: not listed (0).
    expect(from('r6')).toBe('Whole paragraph6.');
    expect(Object.keys(anchorOffsets).sort()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => `OEBPS/a.xhtml#${id}`));
  });

  it('a contents page’s links go to their chapters; a note’s mark, or a link to a note, opens the note', async () => {
    const r = await ingestBytes(
      makeEpub({
        chapters: {
          'toc.xhtml': xhtml('<p><a href="c1.xhtml#ch1">CHAPTER I</a></p><p><a href="c1.xhtml#ch2">CHAPTER II</a></p>'),
          'c1.xhtml': xhtml(
            '<h2 id="ch1">CHAPTER I</h2><p>Text<a href="#fn1">[1]</a>, more<a href="#fn2"><sup>2</sup></a>, and<a href="#gl">a word</a>.</p><h2 id="ch2">CHAPTER II</h2>' +
              '<p id="fn1">[1] First.</p><p id="fn2">2. Second.</p><aside epub:type="footnote" id="gl"><p>A word explained.</p></aside>',
          ),
        },
      }),
      'x.epub',
    );
    expect(r.manifest.anchors).toMatchObject({ 'OEBPS/c1.xhtml#ch1': 2, 'OEBPS/c1.xhtml#ch2': 4 });
    expect(Object.keys(r.manifest.notes ?? {}).sort()).toEqual(['OEBPS/c1.xhtml#fn1', 'OEBPS/c1.xhtml#fn2', 'OEBPS/c1.xhtml#gl']);
  });

  it('a link to a whole chapter is a place to go to; to a short file of its own, a note', async () => {
    const chapter = Array.from({ length: 20 }, (_, i) => `<p>Paragraph ${i}.</p>`).join('');
    const r = await ingestBytes(
      makeEpub({ chapters: { 'a.xhtml': xhtml('<p>See <a href="b.xhtml">chapter two</a> and <a href="n1.xhtml">this</a>.</p>'), 'b.xhtml': xhtml(chapter), 'n1.xhtml': xhtml('<p>A note file.</p>') } }),
      'x.epub',
    );
    expect(r.manifest.anchors?.['OEBPS/b.xhtml']).toBe(1);
    expect(r.manifest.anchorOffsets?.['OEBPS/b.xhtml']).toBeUndefined();
    expect(r.manifest.notes?.['OEBPS/n1.xhtml']).toEqual([21, 22]);
  });

  it('FB2: a link back from the notes goes to its place', async () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns:l="http://www.w3.org/1999/xlink"><body><section><p>One.</p><p id="r1">Word<a l:href="#n1" type="note">1</a>.</p></section></body>' +
      '<body name="notes"><section id="n1"><title><p>1</p></title><p>The note. <a l:href="#r1">Back</a></p></section></body></FictionBook>';
    const r = await ingestBytes(new TextEncoder().encode(xml), 'b.fb2');
    expect(r.manifest.notes?.['#n1']).toBeDefined();
    expect(r.manifest.anchors?.['#r1']).toBe(1);
    expect(r.manifest.anchorOffsets).toEqual({});
  });

  it('FB2: a link back to a mark inside a paragraph lands on the mark', async () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns:l="http://www.w3.org/1999/xlink"><body><section><p>One.</p><p>A long sentence <a l:href="#n1" type="note" id="r1">[1]</a> goes on.</p></section></body>' +
      '<body name="notes"><section id="n1"><title><p>1</p></title><p>The note. <a l:href="#r1">Back</a></p></section></body></FictionBook>';
    const r = await ingestBytes(new TextEncoder().encode(xml), 'b.fb2');
    expect(r.manifest.anchors?.['#r1']).toBe(1);
    expect(blockText(r.blocks[1]).slice(r.manifest.anchorOffsets?.['#r1'])).toBe('[1] goes on.');
  });
});

describe('file names', () => {
  it('names written decomposed (macOS) find the chapters and pictures the package names composed', async () => {
    const opf =
      '<package><metadata><dc:title>Kitap</dc:title><dc:language>tr</dc:language></metadata><manifest><item id="a" href="B%C3%B6l%C3%BCm%201.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>';
    const z = zipSync({
      mimetype: strToU8('application/epub+zip'),
      'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
      'OEBPS/content.opf': strToU8(opf),
      ['OEBPS/Bölüm 1.xhtml'.normalize('NFD')]: strToU8('<html><body><p>Birinci bölümün metni.</p><img src="Resimler/Çizim 1.png"/></body></html>'),
      ['OEBPS/Resimler/Çizim 1.png'.normalize('NFD')]: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    });
    const r = await ingestBytes(z, 'x.epub');
    expect(shown(r)).toEqual(['Birinci bölümün metni.', '[img OEBPS/Resimler/Çizim 1.png]']);
    expect(r.manifest.lang).toBe('tr');
  });
});

describe('short links to headings', () => {
  it('a contents entry of a few letters ("Tears") goes to its chapter, not to a pop-up note', async () => {
    const r = await ingestBytes(
      makeEpub({
        chapters: {
          'toc.xhtml': xhtml('<p><a href="c1.xhtml#h1">Tears</a></p><p><a href="c1.xhtml#ch2">II.,</a></p>'),
          'c1.xhtml': xhtml(`<h4 id="h1">Tears</h4><p>Tears! tears! tears!</p><h2><a id="ch2"/>Chapter II</h2>${'<p>Text.</p>'.repeat(3)}`),
        },
      }),
      'x.epub',
    );
    expect(r.manifest.notes).toEqual({});
    expect(r.manifest.anchors).toEqual({ 'OEBPS/c1.xhtml#h1': 2, 'OEBPS/c1.xhtml#ch2': 4 });
  });

  it('a link to a whole section is a place to go to, however short its text', async () => {
    const r = await ingestBytes(
      makeEpub({ chapters: { 'a.xhtml': xhtml(`<p>See <a href="#s2">2</a>.</p><div id="s2">${'<p>Long section text.</p>'.repeat(30)}</div>`) } }),
      'x.epub',
    );
    expect(r.manifest.anchors?.['OEBPS/a.xhtml#s2']).toBe(1);
    expect(r.manifest.notes?.['OEBPS/a.xhtml#s2']).toBeUndefined();
  });
});
