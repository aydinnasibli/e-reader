// Text encodings: Turkish one-byte files (windows-1254 / ISO-8859-9), files
// whose label is unknown or wrong, UTF-8 with a stray byte, and a guess made
// from more than the start of the file.

import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { Utf8Decoder, createDecoder, decodeUtf8, normalizeEncoding, sniffEncoding } from '../src/engine/decode';
import { blockText } from '../src/engine/types';
import { enc, ingestBytes, legacy, makeEpub } from './helpers';

const TR = 'Ağaçların gölgesinde oturan yaşlı adam, İstanbul’un eski sokaklarını düşünüyordu. Işık azalınca kapıyı kapattı.';
const trBook = Array.from({ length: 60 }, () => TR).join('\n\n');
const texts = (r: { blocks: Parameters<typeof blockText>[0][] }) => r.blocks.map(blockText);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

describe('windows-1254 (Turkish)', () => {
  it('decodes every byte as Node does (ISO-8859-9 too, outside 0x80..0x9F)', () => {
    const all = Uint8Array.from({ length: 128 }, (_, i) => 128 + i);
    const ours = createDecoder('windows-1254', false).decode(all);
    const node = new TextDecoder('windows-1254').decode(all);
    for (let i = 0; i < 128; i++) {
      const c = node.charCodeAt(i);
      // Bytes windows-1254 leaves undefined (C1 controls in Node) are U+FFFD for us.
      expect(ours.charCodeAt(i)).toBe(c >= 0x80 && c <= 0x9f ? 0xfffd : c);
    }
    expect(createDecoder('windows-1254', false).decode(Uint8Array.from([0xd0, 0xdd, 0xde, 0xf0, 0xfd, 0xfe]))).toBe('ĞİŞğış');
  });

  it('knows its labels', () => {
    for (const l of ['windows-1254', 'cp1254', 'ISO-8859-9', 'iso_8859-9', 'ISO8859-9', 'latin5', 'l5', 'x-cp1254', 'csISOLatin5']) {
      expect(normalizeEncoding(l)).toBe('windows-1254');
    }
    expect(normalizeEncoding('ISO-8859-1')).toBe('windows-1252');
    expect(normalizeEncoding('UTF8')).toBe('utf-8');
    expect(normalizeEncoding('klingon-1')).toBeNull();
  });

  it('a cp1254 TXT reads as Turkish, not as Western European', async () => {
    const r = await ingestBytes(legacy(trBook, 'windows-1254'), 'k.txt');
    expect(texts(r)[0]).toBe(TR);
    expect(r.manifest.lang).toBe('tr');
  });

  it('sniffs Turkish, Western European and Russian one-byte text apart', () => {
    const fr = "L'été dernier, nous sommes allés à la mer; c'était très agréable, même s'il pleuvait. ".repeat(20);
    const ru = 'Функция parseInt() в JavaScript: вызов parseInt("42", 10) возвращает number 42; см. MDN Web Docs и ECMAScript. '.repeat(20);
    expect(sniffEncoding(legacy(trBook, 'windows-1254'))).toBe('windows-1254');
    expect(sniffEncoding(legacy(fr, 'windows-1252'))).toBe('windows-1252');
    // Russian with plenty of Latin in it is still Russian.
    expect(sniffEncoding(legacy(ru, 'windows-1251'))).toBe('windows-1251');
    expect(sniffEncoding(legacy(ru, 'koi8-r'))).toBe('koi8-r');
  });

  it('an FB2 saying encoding="windows-1254" (or a label it doesn’t know) reads as Turkish', async () => {
    const fb2 = (label: string) =>
      `<?xml version="1.0" encoding="${label}"?><FictionBook><description><title-info><book-title>Yaşlı adam</book-title><lang>tr</lang></title-info></description>` +
      `<body><section><p>${TR}</p></section></body></FictionBook>`;
    for (const label of ['windows-1254', 'ISO-8859-9', 'x-mac-turkish']) {
      const r = await ingestBytes(legacy(fb2(label), 'windows-1254'), 'k.fb2');
      expect(texts(r)[0]).toBe(TR);
      expect(r.manifest.title).toBe('Yaşlı adam');
    }
  });

  it('an EPUB chapter declaring windows-1254 in its XML declaration or a <meta> reads as Turkish', async () => {
    const pages = [
      `<?xml version="1.0" encoding="windows-1254"?><html><head><title>x</title></head><body><p>${TR}</p></body></html>`,
      `<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1254"/></head><body><p>${TR}</p></body></html>`,
      `<html><head><meta charset="iso-8859-9"></head><body><p>${TR}</p></body></html>`,
    ];
    for (const page of pages) {
      const r = await ingestBytes(makeEpub({ chapters: { 'a.html': legacy(page, 'windows-1254') } }), 'x.epub');
      expect(texts(r)).toEqual([TR]);
    }
  });

  it('a chapter labelled Latin-1 that is plainly Turkish, or plainly UTF-8, is read as what it is', async () => {
    const latin = `<?xml version="1.0" encoding="iso-8859-1"?><html><body><p>${TR}</p></body></html>`;
    expect(texts(await ingestBytes(makeEpub({ chapters: { 'a.xhtml': legacy(latin, 'windows-1254') } }), 'x.epub'))).toEqual([TR]);
    expect(texts(await ingestBytes(makeEpub({ chapters: { 'a.xhtml': enc(latin) } }), 'x.epub'))).toEqual([TR]);
  });

  it('a chapter saying UTF-8 (or nothing) that is really cp1254 is guessed', async () => {
    const page = `<?xml version="1.0" encoding="utf-8"?><html><body><p>${TR}</p><p>${TR}</p></body></html>`;
    expect(texts(await ingestBytes(makeEpub({ chapters: { 'a.xhtml': legacy(page, 'windows-1254') } }), 'x.epub'))).toEqual([TR, TR]);
  });
});

describe('UTF-8 or not', () => {
  it('one stray byte doesn’t turn a UTF-8 Turkish TXT into another encoding', async () => {
    const one = cat(enc('Önsöz\n\n'), Uint8Array.from([0xfd]), enc('\n\n' + trBook));
    const r = await ingestBytes(one, 'k.txt');
    expect(texts(r)).toContain(TR);
    expect(texts(r)[0]).toBe('Önsöz');
  });

  it('looks past an ASCII preface: cp1254 text after 70 KB of plain English', async () => {
    const preface = 'This electronic edition was prepared by volunteers. '.repeat(1400) + '\n\n';
    const r = await ingestBytes(cat(enc(preface), legacy(trBook, 'windows-1254')), 'k.txt');
    expect(texts(r)).toContain(TR);
  });

  it('the JavaScript decoder decodes like TextDecoder, damage included (a bad byte never swallows the next)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    const samples = [
      Uint8Array.from([0xdd, 0x53, 0x54, 0x41, 0x4e]), // cp1254 "İSTAN" read as UTF-8
      Uint8Array.from([0xe2, 0x82, 0x41, 0xf0, 0x9f, 0x98, 0x80, 0xed, 0xa0, 0x80, 0xc0, 0xaf, 0xf4, 0x90, 0x80, 0x80]),
      enc('Hello — Привет — 你好 — 😀 end'),
    ];
    for (let n = 0; n < 200; n++) samples.push(Uint8Array.from({ length: 64 }, () => (rnd() < 0.5 ? 0x41 + Math.floor(rnd() * 26) : Math.floor(rnd() * 256))));
    for (const s of samples) {
      const want = new TextDecoder().decode(s);
      expect(decodeUtf8(s)).toBe(want);
      // Split anywhere, streamed: the same.
      for (const cut of [1, 7, 33]) {
        const d = new Utf8Decoder();
        expect(d.decode(s.subarray(0, cut)) + d.decode(s.subarray(cut)) + d.end()).toBe(want);
      }
    }
  });
});

describe('zip of a Turkish FB2', () => {
  it('reads windows-1254 inside an .fb2.zip', async () => {
    const xml = `<?xml version="1.0" encoding="windows-1254"?><FictionBook><body><section><p>${TR}</p></section></body></FictionBook>`;
    const r = await ingestBytes(zipSync({ 'kitap.fb2': legacy(xml, 'windows-1254'), 'readme.txt': strToU8('x') }), 'kitap.fb2.zip');
    expect(texts(r)).toEqual([TR]);
  });
});

describe('UTF-8 that says so (or says nothing) stays UTF-8', () => {
  const later = 'Later: café, naïve, “quoted”, İstanbul’da şöyle.';

  it('XHTML with no XML declaration but a <meta> saying iso-8859-1 (XML goes by the bytes: UTF-8)', async () => {
    const filler = Array.from({ length: 6000 }, (_, i) => `<p>Paragraph ${i} of plain English text that has no accented letters at all in it.</p>`).join('\n');
    const page = `<html xmlns="http://www.w3.org/1999/xhtml"><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"/><title>x</title></head><body>${filler}<p>${later}</p></body></html>`;
    const { blocks } = await ingestBytes(makeEpub({ chapters: { 'c.xhtml': enc(page) } }), 'b.epub');
    expect(blockText(blocks[blocks.length - 1])).toBe(later);
  });

  it('a UTF-8 FB2 with one stray Latin-1 byte near its start: one U+FFFD, the rest read right', async () => {
    const paras = Array.from({ length: 4000 }, (_, i) => `<p>Paragraph ${i}: "It was a cold day," he said, and they walked on along the river.</p>`).join('\n');
    const head = `<?xml version="1.0" encoding="UTF-8"?><FictionBook><description><title-info><book-title>Test</book-title><lang>en</lang></title-info></description><body><section><p>Copyright `;
    const tail = ` 2004 by the author.</p>${paras}<p>The end — café, naïve, Zürich.</p></section></body></FictionBook>`;
    const { blocks } = await ingestBytes(cat(enc(head), Uint8Array.from([0xa9]), enc(tail)), 'b.fb2');
    expect(blockText(blocks[0])).toBe('Copyright \ufffd 2004 by the author.');
    expect(blockText(blocks[blocks.length - 1])).toBe('The end — café, naïve, Zürich.');
  });
});
