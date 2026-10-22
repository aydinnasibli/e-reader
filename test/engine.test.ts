import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { Utf8Decoder, createDecoder, sniffEncoding } from '../src/engine/decode';
import { type MarkupHandler, MarkupTokenizer } from '../src/engine/markup';
import { BOLD, ITALIC, LINK, SUP, blockText, sliceRuns } from '../src/engine/types';
import { MAX_BLOCK } from '../src/engine/writer';
import { enc, ingestBytes } from './helpers';

function encodeLegacy(s: string, encoding: string): Uint8Array {
  // Build the reverse table from our own decoder and check it against Node's.
  const d = createDecoder(encoding as never, false);
  const rev = new Map<string, number>();
  for (let b = 0; b < 256; b++) rev.set(d.decode(new Uint8Array([b])), b);
  return Uint8Array.from([...s].map((ch) => rev.get(ch) ?? 63));
}

describe('decoders', () => {
  it('decodes UTF-8 split at every byte boundary', () => {
    const text = 'Hello — Привет — 你好 — 😀 end';
    const bytes = enc(text);
    for (let cut = 0; cut <= bytes.length; cut++) {
      const d = new Utf8Decoder();
      expect(d.decode(bytes.subarray(0, cut)) + d.decode(bytes.subarray(cut)) + d.end()).toBe(text);
    }
  });

  it.each(['windows-1251', 'koi8-r'])('matches Node for %s', (e) => {
    const all = Uint8Array.from({ length: 128 }, (_, i) => 128 + i).filter((b) => !(e === 'windows-1251' && b === 0x98));
    expect(createDecoder(e as never, false).decode(all)).toBe(new TextDecoder(e).decode(all));
  });

  it('sniffs encodings', () => {
    const ru = 'Война и мир. Глава первая. Ну что, князь, Генуя и Лукка стали не больше как поместья фамилии Бонапарте.';
    expect(sniffEncoding(enc(ru))).toBe('utf-8');
    expect(sniffEncoding(encodeLegacy(ru, 'windows-1251'))).toBe('windows-1251');
    expect(sniffEncoding(encodeLegacy(ru, 'koi8-r'))).toBe('koi8-r');
    expect(sniffEncoding(Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6f, 0x6b]))).toBe('windows-1252');
  });
});

describe('markup tokenizer', () => {
  function events(input: string, cuts: number[] = []) {
    const out: { tag: boolean; v: string }[] = [];
    const h: MarkupHandler = {
      open: (n, a) => out.push({ tag: true, v: `<${n}${Object.entries(a).map(([k, v]) => ` ${k}=${v}`).join('')}>` }),
      close: (n) => out.push({ tag: true, v: `</${n}>` }),
      text: (t) => {
        // Merge adjacent text so different slicing gives comparable output.
        const last = out[out.length - 1];
        if (last && !last.tag) last.v += t;
        else out.push({ tag: false, v: t });
      },
    };
    const t = new MarkupTokenizer(h);
    let prev = 0;
    for (const c of [...cuts, input.length]) {
      t.feed(input.slice(prev, c));
      prev = c;
    }
    t.end();
    return out.map((e) => e.v);
  }

  const doc =
    '<?xml version="1.0"?><!DOCTYPE html><html><head><style>p { x: "<b>" }</style></head>' +
    '<body><p class="a" title=\'x > y\'>Tom &amp; Jerry &mdash; &#x41;&#66; <i>it</i>' +
    '<br/>a < b</p><!-- c <p> --><![CDATA[<raw>]]><svg:image xlink:href="i.png"/></body></html>';

  it('parses tags, attributes, entities, comments and CDATA', () => {
    expect(events(doc)).toEqual([
      '<html>', '<head>', '<style>', '</style>', '</head>', '<body>',
      '<p class=a title=x > y>', 'Tom & Jerry — AB ', '<i>', 'it', '</i>', '<br>', '</br>',
      'a < b', '</p>', '<raw>', '<image xlink:href=i.png>', '</image>', '</body>', '</html>',
    ]);
  });

  it('gives identical results however the input is sliced', () => {
    const whole = events(doc);
    for (let c = 1; c < doc.length; c++) expect(events(doc, [c])).toEqual(whole);
  });
});

describe('runs', () => {
  it('slices styled runs', () => {
    expect(sliceRuns(['ab', ['cd', BOLD], 'ef'], 1, 5)).toEqual(['b', ['cd', BOLD], 'e']);
  });
});

describe('TXT', () => {
  it('joins hard-wrapped lines into paragraphs separated by blank lines', async () => {
    const txt = 'Chapter 1\r\n\r\nIt was a dark\r\nand stormy night.\r\n\r\nThe end\r\ncame.\r\n\r\nChapter 2\r\n\r\nMore.';
    const { blocks, manifest } = await ingestBytes(enc(txt), 'book.txt');
    expect(blocks.map((b) => [b.k, blockText(b)])).toEqual([
      ['h', 'Chapter 1'],
      ['p', 'It was a dark and stormy night.'],
      ['p', 'The end came.'],
      ['h', 'Chapter 2'],
      ['p', 'More.'],
    ]);
    expect(manifest.toc.map((t) => t.t)).toEqual(['Chapter 1', 'Chapter 2']);
  });

  it('treats every line as a paragraph when there are no blank lines', async () => {
    const { blocks } = await ingestBytes(enc('One line.\nTwo line.\nThree line.\nFour.\n'), 'b.txt');
    expect(blocks.map(blockText)).toEqual(['One line.', 'Two line.', 'Three line.', 'Four.']);
  });

  it('handles cp1251 text and huge lines without line breaks', async () => {
    const word = 'слово ';
    const line = word.repeat(60_000); // 360k chars, no newline
    const bytes = encodeLegacy(line + '\n' + 'Конец.', 'windows-1251');
    const { blocks, manifest } = await ingestBytes(bytes, 'big.txt');
    const text = blocks.map(blockText);
    expect(text.at(-1)).toBe('Конец.');
    expect(Math.max(...text.map((t) => t.length))).toBeLessThanOrEqual(MAX_BLOCK + MAX_BLOCK / 2);
    expect(text.slice(0, -1).join('')).toBe(line.trim());
    expect(blocks.slice(1, -1).every((b) => b.c === 1)).toBe(true);
    expect(manifest.chunks.length).toBeGreaterThan(5);
  });
});

function makeEpub(chapters: Record<string, string>, extra: Record<string, Uint8Array> = {}) {
  const items = Object.keys(chapters)
    .map((n, i) => `<item id="c${i}" href="text/${n}" media-type="application/xhtml+xml"/>`)
    .join('');
  const spine = Object.keys(chapters).map((_, i) => `<itemref idref="c${i}"/>`).join('');
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    ),
    'OEBPS/content.opf': strToU8(
      `<?xml version="1.0"?><package><metadata><dc:title>Test &amp; Book</dc:title><dc:creator>A. Author</dc:creator>` +
        `<meta name="cover" content="cov"/></metadata><manifest>${items}` +
        `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` +
        `<item id="cov" href="img/cover.jpg" media-type="image/jpeg"/></manifest><spine>${spine}</spine></package>`,
    ),
    'OEBPS/nav.xhtml': strToU8(
      '<html><body><nav epub:type="toc"><ol><li><a href="text/one.xhtml">One</a><ol>' +
        '<li><a href="text/one.xhtml#deep">Deep part</a></li></ol></li>' +
        '<li><a href="text/two%20b.xhtml">Two</a></li></ol></nav></body></html>',
    ),
    'OEBPS/img/cover.jpg': Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]),
    ...extra,
  };
  for (const [n, html] of Object.entries(chapters)) files[`OEBPS/text/${n}`] = strToU8(html);
  return zipSync(files);
}

describe('EPUB', () => {
  it('extracts metadata, text, styles, images and resolves the TOC', async () => {
    const epub = makeEpub({
      'one.xhtml':
        '<html><head><title>x</title></head><body><h1>Chapter <em>One</em></h1><p>First <b>bold</b> para.</p>' +
        '<div><p>Nested</p> tail text</div><p><img src="../img/pic.png"/></p><p id="deep">Deep para<sup>1</sup></p></body></html>',
      'two b.xhtml': '<html><body><blockquote><p>Quote</p></blockquote><ul><li>a</li><li>b</li></ul></body></html>',
    }, { 'OEBPS/img/pic.png': Uint8Array.from([137, 80, 78, 71]) });
    const { manifest, blocks, sink } = await ingestBytes(epub, 'x.epub');
    expect(manifest.title).toBe('Test & Book');
    expect(manifest.author).toBe('A. Author');
    expect(blocks.map((b) => [b.k, b.k === 'img' ? b.s : blockText(b)])).toEqual([
      ['h', 'Chapter One'],
      ['p', 'First bold para.'],
      ['p', 'Nested'],
      ['p', 'tail text'],
      ['img', 'OEBPS/img/pic.png'],
      ['p', 'Deep para1'],
      ['q', 'Quote'],
      ['p', '• a'],
      ['p', '• b'],
    ]);
    expect(blocks[0].r).toEqual(['Chapter ', ['One', ITALIC]]);
    expect(blocks[1].r).toEqual(['First ', ['bold ', BOLD], 'para.']);
    expect(blocks[5].r).toEqual(['Deep para', ['1', SUP]]);
    expect(manifest.toc).toEqual([
      { t: 'One', l: 0, b: 0 },
      { t: 'Deep part', l: 1, b: 5 },
      { t: 'Two', l: 0, b: 6 },
    ]);
    expect(manifest.images['OEBPS/img/pic.png']).toMatchObject({ ext: 'png' });
    expect(manifest.cover).toBe('__cover');
    expect(sink.images.has('cover.jpg')).toBe(true);
  });

  it('starts each chapter in a new chunk', async () => {
    const epub = makeEpub({ 'one.xhtml': '<p>a</p>', 'two b.xhtml': '<p>b</p>' });
    const { manifest } = await ingestBytes(epub, 'x.epub');
    expect(manifest.chunks).toEqual([[0, 0], [1, 1]]);
  });
});

describe('FB2', () => {
  it('parses a windows-1251 FB2 with sections, poems, notes and images', async () => {
    const xml =
      '<?xml version="1.0" encoding="windows-1251"?><FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info>' +
      '<author><first-name>Лев</first-name><last-name>Толстой</last-name></author><book-title>Война и мир</book-title>' +
      '<lang>ru</lang><coverpage><image l:href="#cover.jpg"/></coverpage></title-info></description>' +
      '<body><title><p>Война и мир</p></title><section><title><p>Часть первая</p></title>' +
      '<section><title><p>I</p></title><p>Ну, <emphasis>князь</emphasis>.<a l:href="#n1" type="note">1</a></p>' +
      '<empty-line/><poem><stanza><v>Строка один</v><v>Строка два</v></stanza></poem><image l:href="#pic"/></section></section></body>' +
      '<binary id="cover.jpg" content-type="image/jpeg">/9j/AAEC</binary><binary id="pic" content-type="image/png">iVBORw==</binary></FictionBook>';
    const { manifest, blocks, sink } = await ingestBytes(encodeLegacy(xml, 'windows-1251'), 'w.fb2');
    expect(manifest.title).toBe('Война и мир');
    expect(manifest.author).toBe('Лев Толстой');
    expect(blocks.map((b) => [b.k, b.k === 'img' ? b.s : blockText(b)])).toEqual([
      ['h', 'Война и мир'],
      ['h', 'Часть первая'],
      ['h', 'I'],
      ['p', 'Ну, князь.1'],
      ['sp', ''],
      ['v', 'Строка один'],
      ['v', 'Строка два'],
      ['sp', ''],
      ['img', 'pic'],
    ]);
    expect(blocks[3].r).toEqual(['Ну, ', ['князь', ITALIC], '.', ['1', SUP | LINK, '#n1']]);
    expect(manifest.toc).toEqual([
      { t: 'Часть первая', l: 0, b: 1 },
      { t: 'I', l: 1, b: 2 },
    ]);
    expect(manifest.cover).toBe('cover.jpg');
    expect(sink.images.get('b_pic.png')).toBe('iVBORw==');
  });

  it('reads an FB2 inside a zip', async () => {
    const xml = '<?xml version="1.0" encoding="utf-8"?><FictionBook><body><section><p>Hi</p></section></body></FictionBook>';
    const { blocks, manifest } = await ingestBytes(zipSync({ 'book.fb2': strToU8(xml) }), 'book.fb2.zip');
    expect(manifest.format).toBe('fb2');
    expect(blocks.map(blockText)).toEqual(['Hi']);
  });
});

describe('TXT headings', () => {
  it('detects non-Latin chapter headings', async () => {
    const { manifest } = await ingestBytes(enc('Глава 1\nТекст.\nГлава вторая\nЕщё текст.\nFəsil 3\nSon.\n'), 'r.txt');
    expect(manifest.toc.map((t) => t.t)).toEqual(['Глава 1', 'Глава вторая', 'Fəsil 3']);
  });
});

describe('footnotes', () => {
  it('links EPUB note references to the note blocks', async () => {
    const epub = makeEpub({
      'one.xhtml': '<p>Text<a href="two%20b.xhtml#n1"><sup>1</sup></a> more <a href="http://x.org">web</a>.</p>',
      'two b.xhtml': '<h2>Notes</h2><aside id="n1"><p>First note.</p><p>Second para.</p></aside><p id="n2">Other</p>',
    });
    const { manifest, blocks } = await ingestBytes(epub, 'x.epub');
    expect(blocks[0].r).toEqual(['Text', ['1', SUP | LINK, 'OEBPS/text/two b.xhtml#n1'], ' more web.']);
    expect(manifest.notes?.['OEBPS/text/two b.xhtml#n1']).toEqual([2, 4]);
    expect(manifest.notes?.['OEBPS/text/two b.xhtml#n2']).toBeUndefined();
  });

  it('links FB2 note references to note sections', async () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns:l="http://www.w3.org/1999/xlink"><body><section><p>Word<a l:href="#n1" type="note">[1]</a>.</p></section></body>' +
      '<body name="notes"><section id="n1"><title><p>1</p></title><p>The note.</p></section></body></FictionBook>';
    const { manifest, blocks } = await ingestBytes(enc(xml), 'n.fb2');
    expect(blocks[0].r).toEqual(['Word', ['[1]', SUP | LINK, '#n1'], '.']);
    expect(manifest.notes?.['#n1']).toEqual([1, 3]);
    expect(blocks.slice(1, 3).map(blockText)).toEqual(['1', 'The note.']);
  });
});
