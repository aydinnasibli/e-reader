// EPUB tables (one paragraph per row) and copy-protected EPUBs (refused with a clear message).

import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { BookError } from '../src/engine/io';
import { BOLD, type Block, blockText, runStyle, runText } from '../src/engine/types';
import { ingestBytes } from './helpers';

/** A minimal EPUB: chapters (file name -> XHTML) under OEBPS/, plus extra files at the given paths. */
function epub(chapters: Record<string, string>, extra: Record<string, string> = {}) {
  const names = Object.keys(chapters);
  const items = names.map((n, i) => `<item id="c${i}" href="${n}" media-type="application/xhtml+xml"/>`).join('');
  const spine = names.map((_, i) => `<itemref idref="c${i}"/>`).join('');
  const f: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8(`<package><metadata><dc:title>T</dc:title></metadata><manifest>${items}</manifest><spine>${spine}</spine></package>`),
  };
  for (const [n, html] of Object.entries(chapters)) f[`OEBPS/${n}`] = strToU8(html);
  for (const [n, text] of Object.entries(extra)) f[n] = strToU8(text);
  return zipSync(f);
}

const chapter = (body: string) => epub({ 'a.xhtml': `<html><body>${body}</body></html>` });
const texts = (blocks: Block[]) => blocks.map(blockText);
const boldText = (b: Block) => (b.r ?? []).filter((r) => runStyle(r) & BOLD).map(runText).join('');

describe('tables', () => {
  it('a row is one paragraph, cells joined, header cells bold', async () => {
    const { blocks } = await ingestBytes(
      chapter(
        '<p>Before</p><table><caption>Kings</caption><thead><tr><th>Name</th><th>Reign</th></tr></thead>' +
          '<tbody><tr><td>Alfred</td><td>871–899</td></tr><tr><td><p>Edward</p><p>the Elder</p></td><td>899–924</td></tr></tbody></table><p>After</p>',
      ),
      'k.epub',
    );
    expect(texts(blocks)).toEqual(['Before', 'Kings', 'Name · Reign', 'Alfred · 871–899', 'Edward the Elder · 899–924', 'After']);
    expect(boldText(blocks[2]).replace(/\s/g, '')).toBe('NameReign');
    expect(boldText(blocks[3])).toBe('');
  });

  it('unclosed cells and rows (old HTML) and empty cells', async () => {
    const { blocks } = await ingestBytes(chapter('<table><tr><td>a<td><td>c<tr><td>d<td>e</table><p>x</p>'), 't.epub');
    expect(texts(blocks)).toEqual(['a · c', 'd · e', 'x']);
  });

  it('a nested table gets rows of its own; the outer row goes on around it', async () => {
    const { blocks } = await ingestBytes(
      chapter('<table><tr><td>outer 1</td><td><table><tr><td>in a</td><td>in b</td></tr></table></td><td>outer 3</td></tr><tr><td>last</td></tr></table>'),
      'n.epub',
    );
    expect(texts(blocks)).toEqual(['outer 1', 'in a · in b', 'outer 3', 'last']);
  });

  it('line breaks, headings and lists inside a cell stay in the row', async () => {
    const { blocks } = await ingestBytes(chapter('<table><tr><td>one<br/>two</td><td><h3>Head</h3><ul><li>x</li><li>y</li></ul></td></tr></table>'), 'c.epub');
    expect(texts(blocks)).toEqual(['one two · Head x y']);
    expect(boldText(blocks[0]).trim()).toBe('Head');
  });

  it('a huge table converts quickly, one block per row', async () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => `<tr><td>r${i}</td><td>v${i}</td><td>w${i}</td></tr>`).join('\n');
    const t0 = Date.now();
    const { blocks } = await ingestBytes(chapter(`<table>${rows}</table>`), 'h.epub');
    expect(blocks).toHaveLength(20_000);
    expect(blockText(blocks[19_999])).toBe('r19999 · v19999 · w19999');
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

const ENC = (algorithm: string, uri: string) =>
  `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">` +
  `<EncryptionMethod Algorithm="${algorithm}"/><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><resource xmlns="http://ns.adobe.com/adept"/></KeyInfo>` +
  `<CipherData><CipherReference URI="${uri}"/></CipherData></EncryptedData></encryption>`;
const AES = 'http://www.w3.org/2001/04/xmlenc#aes128-cbc';
const book = { 'a.xhtml': '<html><body><p>Readable</p></body></html>' };

describe('copy-protected EPUBs', () => {
  it('refuses encrypted chapters (Adobe ADEPT) with a clear message', async () => {
    const file = epub(book, { 'META-INF/encryption.xml': ENC(AES, 'OEBPS/a.xhtml'), 'META-INF/rights.xml': '<rights/>' });
    const err = await ingestBytes(file, 'x.epub').catch((e) => e);
    expect(err).toBeInstanceOf(BookError);
    expect(err.message).toMatch(/copy-protected \(DRM\)/);
  });

  it('refuses encrypted content even without rights.xml, and a chapter without a file extension', async () => {
    await expect(ingestBytes(epub(book, { 'META-INF/encryption.xml': ENC(AES, 'OEBPS/a.xhtml') }), 'x.epub')).rejects.toThrow(/DRM/);
    const noExt = epub({ chapter1: '<html><body><p>x</p></body></html>' }, { 'META-INF/encryption.xml': ENC(AES, 'OEBPS/chapter1') });
    await expect(ingestBytes(noExt, 'x.epub')).rejects.toThrow(/DRM/);
  });

  it('refuses Apple FairPlay and Readium LCP books', async () => {
    await expect(ingestBytes(epub(book, { 'META-INF/sinf.xml': '<fairplay:sinf/>' }), 'x.epub')).rejects.toThrow(/DRM/);
    await expect(ingestBytes(epub(book, { 'META-INF/license.lcpl': '{}' }), 'x.epub')).rejects.toThrow(/DRM/);
  });

  it('accepts books whose fonts are only obfuscated', async () => {
    const enc =
      '<encryption>' +
      ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']
        .map((a, i) => `<EncryptedData><EncryptionMethod Algorithm="${a}"/><CipherData><CipherReference URI="OEBPS/fonts/f${i}.otf"/></CipherData></EncryptedData>`)
        .join('') +
      '</encryption>';
    const { blocks } = await ingestBytes(epub(book, { 'META-INF/encryption.xml': enc }), 'x.epub');
    expect(texts(blocks)).toEqual(['Readable']);
  });

  it('a really encrypted font alone does not block the text', async () => {
    const { blocks } = await ingestBytes(epub(book, { 'META-INF/encryption.xml': ENC(AES, 'OEBPS/fonts/f.otf') }), 'x.epub');
    expect(texts(blocks)).toEqual(['Readable']);
  });
});
