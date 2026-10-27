// FB2 books made or edited by hand: elements left open, the <style>
// element, pictures whose ids a file name can't hold. Each was wrong before
// its fix.

import { describe, expect, it } from 'vitest';
import { ITALIC, LINK, SUP, blockText } from '../src/engine/types';
import { enc, ingestBytes } from './helpers';

const fb2 = (body: string, more = '') =>
  '<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><book-title>T</book-title><lang>tr</lang></title-info></description>' +
  `<body>${body}</body>${more}</FictionBook>`;
const NOTES = '<body name="notes"><section id="n1"><p>Not.</p></section></body>';

describe('elements left open', () => {
  it('an <emphasis> or a note’s <a> left open in a paragraph ends with it, not at the end of the book', async () => {
    const { blocks } = await ingestBytes(enc(fb2('<section><p>Bir <emphasis>iki</p><p>üç dört</p><p>beş <a l:href="#n1" type="note">[1]</p><p>altı yedi</p></section>', NOTES)), 'x.fb2');
    expect(blocks.map((b) => b.r)).toEqual([['Bir ', ['iki', ITALIC]], ['üç dört'], ['beş ', ['[1]', SUP | LINK, '#n1']], ['altı yedi'], ['Not.']]);
  });

  it('an epigraph or a title left open ends with its section', async () => {
    const { blocks, manifest } = await ingestBytes(
      enc(fb2('<section><epigraph><p>Söz.</p></section><section><title><p>İkinci Bölüm</section><section><p>Metin.</p></section>')),
      'x.fb2',
    );
    expect(blocks.map((b) => `${b.k}:${blockText(b)}`)).toEqual(['q:Söz.', 'h:İkinci Bölüm', 'p:Metin.']);
    expect(manifest.toc.map((t) => t.t)).toEqual(['İkinci Bölüm']);
  });
});

describe('the <style> element', () => {
  it('keeps its text: in FB2 it marks text in a style of the book’s own, it holds no style sheet', async () => {
    const { blocks } = await ingestBytes(enc(fb2('<section><p>Bir <style name="foreign lang">çok <emphasis>önemli</emphasis></style> metin.</p></section>')), 'x.fb2');
    expect(blocks[0].r).toEqual(['Bir çok ', ['önemli ', ITALIC], 'metin.']);
  });
});

describe('pictures', () => {
  it('two ids that make the same file name (letters a file name can’t hold) get files of their own', async () => {
    const xml = fb2(
      '<section><image l:href="#обложка.jpg"/><image l:href="#рисунок.jpg"/><image l:href="#pic"/></section>',
      '<binary id="обложка.jpg" content-type="image/jpeg">AAAA</binary><binary id="рисунок.jpg" content-type="image/jpeg">BBBB</binary><binary id="pic" content-type="image/png">CCCC</binary>',
    );
    const { manifest, sink } = await ingestBytes(enc(xml), 'x.fb2');
    const fileOf = (id: string) => (manifest.images[id] as { file: string }).file;
    expect(new Set(['обложка.jpg', 'рисунок.jpg', 'pic'].map(fileOf)).size).toBe(3);
    expect(sink.images.get(fileOf('обложка.jpg'))).toBe('AAAA');
    expect(sink.images.get(fileOf('рисунок.jpg'))).toBe('BBBB');
    // A name that needn't change stays as it was.
    expect(fileOf('pic')).toBe('b_pic.png');
  });
});
