// Sloppy and unusual (X)HTML in books: implied end tags, stray end tags,
// list numbering, entities, MathML, printed page numbers, line breaks, and
// markup that never ends. Each was wrong (or froze) before its fix.

import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { HtmlToBlocks } from '../src/engine/html';
import { MarkupTokenizer, decodeEntities } from '../src/engine/markup';
import { blockText } from '../src/engine/types';
import { BookWriter } from '../src/engine/writer';
import { MemorySink, ingestBytes, makeEpub, xhtml } from './helpers';

/** Blocks of an HTML snippet run through the converter directly. */
function convert(html: string) {
  const sink = new MemorySink();
  const w = new BookWriter(sink);
  const h = new HtmlToBlocks(w, { image: () => null });
  const t = new MarkupTokenizer(h);
  t.feed(html);
  t.end();
  h.finish();
  w.finish();
  return sink.blocks();
}
const kindsAndText = (html: string) => convert(html).map((b) => `${b.k}${b.l ?? ''}:${blockText(b)}`);

describe('implied end tags', () => {
  it('a heading closed with the wrong level ends the heading', () => {
    expect(kindsAndText('<h2>Chapter One</h1><p>It was a quiet morning.</p><p>Nobody came.</p>')).toEqual(['h2:Chapter One', 'p:It was a quiet morning.', 'p:Nobody came.']);
  });

  it('a new paragraph, list item or heading ends an open one', () => {
    expect(kindsAndText('<p>One<p>Two<div>Three</div><ul><li>a<li>b<ul><li>b1</ul><li>c</ul><dl><dt>t<dd>d<dt>u</dl><h3>H<h4>I</h4>')).toEqual([
      'p:One', 'p:Two', 'p:Three', 'p:• a', 'p:• b', 'p:• b1', 'p:• c', 'p:t', 'p:d', 'p:u', 'h3:H', 'h4:I',
    ]);
  });

  it('a paragraph outside a table stays open inside its cells', () => {
    expect(kindsAndText('<table><tr><td><p>a<p>b</td><td>c</td></tr></table>')).toEqual(['p:a b · c']);
  });

  it('the body ends a head left open, as browsers end it: the chapter isn’t skipped with the head', () => {
    expect(kindsAndText('<html><head><title>T</title><body><h1>Bir</h1><p>Metin burada.</p></body></html>')).toEqual(['h1:Bir', 'p:Metin burada.']);
  });

  it('stray end tags are dropped at once: thousands of them take no longer than the text', () => {
    const time = (n: number) => {
      let s = '<body>';
      for (let i = 0; i < n; i++) s += `<p>Para ${i} text</font>`;
      const t0 = performance.now();
      const blocks = convert(s + '</body>');
      expect(blocks).toHaveLength(n);
      return performance.now() - t0;
    };
    time(2000);
    // (Taken in turns, best of three: a busy machine slows both alike.)
    let small = Infinity;
    let big = Infinity;
    for (let i = 0; i < 3; i++) {
      small = Math.min(small, time(10_000));
      big = Math.min(big, time(40_000));
    }
    // Linear (×4), not quadratic (×16).
    expect(big / Math.max(small, 1)).toBeLessThan(9);
  });
});

describe('lists', () => {
  it('start, type, reversed and value', () => {
    expect(convert('<ol start="4"><li>Fourth</li><li>Fifth</li></ol><ol type="a"><li>alpha</li><li value="5">echo</li></ol><ol type="I"><li>one</li><li>two</li></ol><ol reversed="" start="3"><li>c</li><li>b</li></ol>').map(blockText)).toEqual([
      '4. Fourth', '5. Fifth', 'a. alpha', 'e. echo', 'I. one', 'II. two', '3. c', '2. b',
    ]);
  });

  it('no second number or bullet when the text has its own, or the list says none', () => {
    expect(convert('<ol><li>1. Wash</li><li>2) Dry</li><li>(c) Fold</li></ol><ul><li>• Already</li><li>- Dash</li></ul><ol style="list-style-type:none"><li>Plain</li></ol>').map(blockText)).toEqual([
      '1. Wash', '2) Dry', '(c) Fold', '• Already', '- Dash', 'Plain',
    ]);
  });
});

describe('entities', () => {
  it('the HTML 4 names, case-sensitive', () => {
    expect(decodeEntities('&Omega;&omega; &Sigma;&Delta; &lsaquo;fr&rsaquo; &thorn;&ETH; &hearts; &rArr; &le;&ge;&ne;&infin; &oline; &image; &OMEGA;')).toBe('Ωω ΣΔ ‹fr› þÐ ♥ ⇒ ≤≥≠∞ ‾ ℑ &OMEGA;');
  });

  it('numbers 128 to 159 are the windows-1252 characters there, as old HTML meant them', () => {
    expect(decodeEntities('&#150;x&#151; it&#146;s &#147;q&#148; &#128;5 &#x99;')).toBe('–x— it’s “q” €5 ™');
    expect(decodeEntities('&#0;&#xD800;&#x110000;')).toBe('\ufffd\ufffd\ufffd');
  });

  it('a name every object has ("constructor", "toString") is no entity: it stays as written', () => {
    expect(decodeEntities('a &constructor; b &toString; c')).toBe('a &constructor; b &toString; c');
  });
});

describe('things that aren’t text', () => {
  it('MathML annotations (TeX) and SVG titles and descriptions are dropped', () => {
    expect(
      convert('<p>Area <math><semantics><mrow><mi>π</mi><msup><mi>r</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">\\pi r^2</annotation></semantics></math> here.</p><svg><title>Cover</title><desc>A ship</desc></svg>').map(blockText),
    ).toEqual(['Area πr2 here.']);
  });

  it('printed page numbers (EPUB 3 page breaks) don’t show in the middle of a sentence', () => {
    expect(convert('<p>end of a sen<span epub:type="pagebreak" role="doc-pagebreak" id="p12" title="12">12</span>tence</p>').map(blockText)).toEqual(['end of a sentence']);
  });

  it('after a <br/>, the source file’s indentation is not a space', () => {
    expect(convert('<p>Line one,<br/>\n    line two,<br />\n\t<i>line three</i></p>')[0].r).toEqual(['Line one,\nline two,\n', ['line three', 2]]);
  });
});

describe('markup that never ends', () => {
  it('an unterminated comment is read past once, not again for every slice', () => {
    const p = '<p>Some ordinary words in a paragraph of a book, nothing special here at all.</p>\n';
    const time = (n: number) => {
      const t = new MarkupTokenizer({ open() {}, close() {}, text() {} });
      const html = '<p>Intro</p><!-- a comment that never ends ' + p.repeat(n);
      const t0 = performance.now();
      for (let i = 0; i < html.length; i += 16_384) t.feed(html.slice(i, i + 16_384));
      t.end();
      return performance.now() - t0;
    };
    time(1000);
    // (Taken in turns, best of three: a busy machine slows both alike.)
    let small = Infinity;
    let big = Infinity;
    for (let i = 0; i < 3; i++) {
      small = Math.min(small, time(5000));
      big = Math.min(big, time(40_000));
    }
    expect(big / Math.max(small, 1)).toBeLessThan(20);
  });

  it('a heading holding a whole chapter is split like a paragraph', async () => {
    const line = 'Words of a whole chapter written inside a heading by mistake.<br/>\n';
    const r = await ingestBytes(makeEpub({ chapters: { 'a.xhtml': xhtml(`<h3>${line.repeat(2000)}</h3><p>After</p>`) } }), 'x.epub');
    expect(Math.max(...r.blocks.map((b) => blockText(b).length))).toBeLessThan(4000);
    expect(blockText(r.blocks.at(-1)!)).toBe('After');
  });
});

describe('text as stored', () => {
  it('composed (NFC), so decomposed text from macOS tools finds the same words', async () => {
    const nfd = 'Bölüm Şeker İstanbul café'.normalize('NFD');
    const r = await ingestBytes(makeEpub({ chapters: { 'a.xhtml': xhtml(`<h1>${nfd}</h1><p>${nfd}</p>`) }, metadata: `<dc:title>${nfd}</dc:title>` }), 'x.epub');
    expect(r.blocks.map(blockText)).toEqual(['Bölüm Şeker İstanbul café', 'Bölüm Şeker İstanbul café']);
    expect(r.manifest.title).toBe('Bölüm Şeker İstanbul café');
  });

  it('without NUL characters', async () => {
    const r = await ingestBytes(new TextEncoder().encode('Before\u0000after the nul.\n'), 'n.txt');
    expect(r.blocks.map(blockText)).toEqual(['Before\ufffdafter the nul.']);
  });
});

describe('printed page numbers', () => {
  it('a self-closed page break doesn’t end the italic span, centred div or note it sits in', async () => {
    const italic = await ingestBytes(makeEpub({ chapters: { 'c.xhtml': xhtml('<p><span style="font-style:italic">one <span epub:type="pagebreak" id="p5" title="5"/> two</span> three</p>') } }), 'b.epub');
    expect(italic.blocks[0].r).toEqual([['one two ', 2], 'three']);
    const centred = await ingestBytes(makeEpub({ chapters: { 'c.xhtml': xhtml('<div style="text-align:center"><p>one</p><div epub:type="pagebreak" id="p5" title="5"/><p>two</p></div><p>three</p>') } }), 'b.epub');
    expect(centred.blocks.map((b) => b.a)).toEqual(['c', 'c', undefined]);
    const note = await ingestBytes(
      makeEpub({
        chapters: {
          'c.xhtml': xhtml('<p>Text<a href="n.xhtml#n1"><sup>1</sup></a> more.</p>'),
          'n.xhtml': xhtml('<div class="footnote" id="n1"><p>Part one of the note.</p><div epub:type="pagebreak" id="page9" title="9"/><p>Part two of the note.</p></div><p>After the note.</p>'),
        },
      }),
      'b.epub',
    );
    const [a, b] = note.manifest.notes!['OEBPS/n.xhtml#n1'];
    expect(note.blocks.slice(a, b).map(blockText)).toEqual(['Part one of the note.', 'Part two of the note.']);
  });

  it('ebookmaker’s page numbers are dropped from the text and are places to link to, not notes', async () => {
    const r = await ingestBytes(
      makeEpub({
        chapters: {
          'c.xhtml': xhtml('<p>See page <a href="#page_2">2</a>.</p><p>One<span class="x-ebookmaker-pageno" title="{2}" id="pg2"><a id="page_2" title="{2}"></a>[Pg 2]</span> two.</p>'),
        },
      }),
      'b.epub',
    );
    expect(r.blocks.map(blockText)).toEqual(['See page 2.', 'One two.']);
    expect(r.manifest.anchors?.['OEBPS/c.xhtml#page_2']).toBe(1);
    expect(r.manifest.notes?.['OEBPS/c.xhtml#page_2']).toBeUndefined();
  });
});

describe('a stray </p>', () => {
  it('after an implied end it still ends a paragraph: <div><p>a<div>b</div>c</p>d</div>', async () => {
    const { blocks } = await ingestBytes(makeEpub({ chapters: { 'c.xhtml': xhtml('<div><p>a<div>b</div>c</p>d</div>') } }), 'b.epub');
    expect(blocks.map(blockText)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('text cut by a slice of the file', () => {
  it('a decomposed é split between two 64 KB slices of a stored chapter is composed', async () => {
    const te = new TextEncoder();
    const head = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><p>';
    const pad = 65535 - te.encode(head).length;
    // "e" is the last byte of the first slice, U+0301 the first of the next.
    const page = te.encode(head + 'a'.repeat(pad - 1) + ' e\u0301te</p></body></html>');
    const book = zipSync(
      {
        mimetype: strToU8('application/epub+zip'),
        'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>'),
        'c.opf': strToU8('<package><metadata><dc:title>T</dc:title></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>'),
        'c.xhtml': page,
      },
      { level: 0 },
    );
    const r = await ingestBytes(book, 'b.epub');
    expect(r.blocks.map(blockText).join('').endsWith(' \u00e9te')).toBe(true);
  });
});
