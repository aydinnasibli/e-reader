// How a TXT file's lines become paragraphs: hard-wrapped text (Project
// Gutenberg wraps at about 70 characters) is joined back into paragraphs,
// verse keeps its line breaks, and chapter headings are found, Turkish ones
// too, but not in a list of contents.

import { describe, expect, it } from 'vitest';
import { detectLayout, isHeadingLine } from '../src/engine/txt';
import { blockText } from '../src/engine/types';
import { enc, ingestBytes } from './helpers';

const WORDS =
  'the morning was cold and grey when he left the house and walked along the river towards the town where his sister lived with her husband and their children who had not seen him for many years'.split(
    ' ',
  );
let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

/** A paragraph of a few sentences. */
function paragraph(sentences: number): string {
  const out: string[] = [];
  for (let s = 0; s < sentences; s++) {
    const n = 6 + Math.floor(rnd() * 14);
    const w = Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]);
    w[0] = w[0][0].toUpperCase() + w[0].slice(1);
    out.push(w.join(' ') + (rnd() < 0.2 ? '?' : '.'));
  }
  return out.join(' ');
}

/** Greedy wrapping at `width`, as tools that hard-wrap text do; `indent` starts the first line. */
function wrap(p: string, width: number, indent = ''): string[] {
  const lines: string[] = [];
  let line = indent;
  for (const w of p.split(' ')) {
    if (line.trim() && line.length + 1 + w.length > width) {
      lines.push(line);
      line = w;
    } else line = line.trim() ? line + ' ' + w : line + w;
  }
  if (line) lines.push(line);
  return lines;
}

function book(paras = 60) {
  seed = 1;
  return Array.from({ length: paras }, () => paragraph(3 + Math.floor(rnd() * 6)));
}

const texts = (r: { blocks: Parameters<typeof blockText>[0][] }) => r.blocks.map(blockText);

describe('hard-wrapped text is joined into paragraphs', () => {
  const paras = book();

  it('blank lines between long paragraphs (Gutenberg)', async () => {
    const txt = paras.map((p) => wrap(p, 70).join('\r\n')).join('\r\n\r\n');
    expect(detectLayout([txt.split('\r\n')])).toMatchObject({ wrap: 70, blank: true });
    const r = await ingestBytes(enc(txt), 'b.txt');
    expect(texts(r)).toEqual(paras);
  });

  it('no blank lines, each paragraph starting with an indent', async () => {
    const txt = paras.map((p) => wrap(p, 72, '    ').join('\n')).join('\n');
    const r = await ingestBytes(enc(txt), 'b.txt');
    expect(texts(r)).toEqual(paras);
  });

  it('no blank lines and no indent: a paragraph ends with a short line ending a sentence', async () => {
    const txt = paras.map((p) => wrap(p, 72).join('\n')).join('\n');
    const r = await ingestBytes(enc(txt), 'b.txt');
    // Only a paragraph whose last line happens to be full can't be told from the next one.
    const full = paras.filter((p, i) => i + 1 < paras.length && wrap(p, 72).at(-1)!.length + 1 + paras[i + 1].indexOf(' ') > 72).length;
    expect(r.blocks.length).toBeGreaterThanOrEqual(paras.length - full);
    expect(texts(r)[0].startsWith(paras[0])).toBe(true);
  });

  it('chapter headings in wrapped text, with or without blank lines around them', async () => {
    const chapter = (n: number) => `CHAPTER ${['I', 'II', 'III'][n]}.`;
    const blank = [0, 1, 2].map((n) => `${chapter(n)}\n\n` + paras.slice(n * 5, n * 5 + 5).map((p) => wrap(p, 70).join('\n')).join('\n\n')).join('\n\n\n');
    const tight = [0, 1, 2].map((n) => `${chapter(n)}\n` + paras.slice(n * 5, n * 5 + 5).map((p) => wrap(p, 70).join('\n')).join('\n')).join('\n');
    for (const txt of [blank, tight]) {
      const r = await ingestBytes(enc(txt), 'b.txt');
      expect(r.manifest.toc.map((t) => t.t)).toEqual(['CHAPTER I.', 'CHAPTER II.', 'CHAPTER III.']);
    }
  });

  it('short lines inside wrapped text (a letter’s heading, a poem) keep their line breaks', async () => {
    const prose = (ps: string[]) => ps.map((p) => wrap(p, 70).join('\n')).join('\n\n');
    const txt =
      prose(paras.slice(0, 8)) +
      '\n\nTitle: Metamorphosis\nAuthor: Franz Kafka\nTranslator: David Wyllie\n\n' +
      '    The woods are lovely, dark and deep,\n    But I have promises to keep,\n    And miles to go before I sleep.\n\n' +
      prose(paras.slice(8, 16));
    const r = await ingestBytes(enc(txt), 'b.txt');
    expect(texts(r)).toEqual([
      ...paras.slice(0, 8),
      'Title: Metamorphosis\nAuthor: Franz Kafka\nTranslator: David Wyllie',
      'The woods are lovely, dark and deep,\nBut I have promises to keep,\nAnd miles to go before I sleep.',
      ...paras.slice(8, 16),
    ]);
  });
});

describe('verse', () => {
  const stanza1 = ['Two roads diverged in a yellow wood,', 'And sorry I could not travel both', 'And be one traveler, long I stood'];
  const stanza2 = ['Then took the other, as just as fair,', 'And having perhaps the better claim,', 'Because it was grassy and wanted wear;'];

  it('stanzas keep their lines, with a gap between them', async () => {
    const txt = `${stanza1.join('\n')}\n\n${stanza2.join('\n')}\n\n`.repeat(12);
    const r = await ingestBytes(enc(txt), 'p.txt');
    expect(r.blocks[0]).toMatchObject({ k: 'v' });
    expect(texts(r).slice(0, 3)).toEqual([stanza1.join('\n'), '', stanza2.join('\n')]);
    expect(r.blocks[1].k).toBe('sp');
  });

  it('short prose lines broken anywhere are still joined (they run on in lower case)', async () => {
    const r = await ingestBytes(enc('It was a dark\nand stormy night.\n\nThe end\ncame.\n'), 'b.txt');
    expect(texts(r)).toEqual(['It was a dark and stormy night.', 'The end came.']);
  });
});

describe('chapter headings', () => {
  it('Turkish headings, matched whatever their capitals and dotted or dotless i', () => {
    for (const h of ['Birinci Bölüm', 'BİRİNCİ BÖLÜM…', 'On İkinci Bölüm', 'Son Bölüm', '1. Bölüm', '6. BÖLÜM', 'IV. KISIM', 'Bölüm 3', 'BÖLÜM III', 'KISIM 2', 'Kısım 2', 'ÖNSÖZ', 'Önsöz', 'GİRİŞ', 'SONSÖZ', 'İÇİNDEKİLER', 'Bölüm: Yeni Başlangıç']) {
      expect(isHeadingLine(h), h).toBe(true);
    }
    for (const s of ['Giriş kapısı açıktı.', 'Birinci bölüm bitti, ikincisi başladı ve herkes sustu.', '1. bölümde anlatıldığı gibi', 'Bölümün sonunda herkes ağladı.']) {
      expect(isHeadingLine(s), s).toBe(false);
    }
  });

  it('English ones as before, and not a caption’s end', () => {
    for (const h of ['Chapter 12', 'CHAPTER I.', 'Part II: The Return', 'Letter 4', 'Prologue', 'Глава первая', 'XIV']) expect(isHeadingLine(h), h).toBe(true);
    for (const s of ['Part of me wanted to stay.', 'Book me a flight, she said.', 'Chapter I.]', 'chapter and verse']) expect(isHeadingLine(s), s).toBe(false);
  });

  it('a Turkish TXT gets its contents', async () => {
    const body = book(6).join('\n\n');
    const txt = ['ÖNSÖZ', body, 'BİRİNCİ BÖLÜM', body, '2. Bölüm', body, 'SONSÖZ', body].join('\n\n');
    const r = await ingestBytes(enc(txt), 'kitap.txt');
    expect(r.manifest.toc.map((t) => t.t)).toEqual(['ÖNSÖZ', 'BİRİNCİ BÖLÜM', '2. Bölüm', 'SONSÖZ']);
  });

  it('a list of contents is a list, not a run of chapters each on its own page', async () => {
    const chapters = ['Chapter I.', 'Chapter II.', 'Chapter III.', 'Chapter IV.'];
    const body = book(3).map((p) => wrap(p, 70).join('\n')).join('\n\n');
    for (const list of [chapters.join('\n'), chapters.join('\n\n')]) {
      const txt = `Contents\n\n${list}\n\n\n${chapters.map((c) => `${c}\n\n${body}`).join('\n\n\n')}`;
      const r = await ingestBytes(enc(txt), 'b.txt');
      const toc = r.manifest.toc.map((t) => t.t);
      expect(toc.slice(-4)).toEqual(chapters);
      expect(toc.length).toBeLessThanOrEqual(5);
      // The listed entries are plain text before the first chapter.
      const first = r.manifest.toc.find((t) => t.t === 'Chapter I.')!.b;
      expect(texts(r).slice(0, first).join('\n')).toContain('Chapter IV.');
    }
  });
});

describe('headings in a row, and lines that only look like headings', () => {
  const body =
    'Alexey Fyodorovitch Karamazov was the third son of Fyodor Pavlovitch\nKaramazov, a land owner well known in our district in his own day, and\nstill remembered among us owing to his gloomy and tragic death, which\nhappened thirteen years ago, and which I shall describe in its proper\nplace.';

  it('PART / Book / Chapter in a row (Gutenberg 28054, The Brothers Karamazov) are headings, not a list of contents', async () => {
    const part = (p: string, b: string) => `${p}\n\n\n\n${b}\n\n\n\nChapter I.\n\n\n${body}\n\n${body}\n\n\nChapter II.\n\n\n${body}\n\n${body}\n\n\n`;
    const r = await ingestBytes(enc(part('PART I', 'Book I. The History Of A Family') + part('PART II', 'Book IV. Lacerations')), 'b.txt');
    expect(r.manifest.toc.map((t) => t.t)).toEqual(['PART I', 'Book I. The History Of A Family', 'Chapter I.', 'Chapter II.', 'PART II', 'Book IV. Lacerations', 'Chapter I.', 'Chapter II.']);
  });

  it('a list of contents ending with the text’s own "BOOK ONE", "CHAPTER I" (War and Peace)', async () => {
    const list = ['BOOK ONE: 1805', 'CHAPTER I', 'CHAPTER II', 'BOOK TWO: 1805', 'CHAPTER I', 'CHAPTER II'];
    const txt = `CONTENTS\n\n${list.map((l) => '    ' + l).join('\n\n')}\n\n\n\nBOOK ONE: 1805\n\n\nCHAPTER I\n\n${body}\n\n\nCHAPTER II\n\n${body}\n`;
    const r = await ingestBytes(enc(txt), 'b.txt');
    expect(r.manifest.toc.map((t) => t.t)).toEqual(['CONTENTS', 'BOOK ONE: 1805', 'CHAPTER I', 'CHAPTER II']);
  });

  it('"BOOK FOURTH—SUCCOR FROM BELOW…" is a heading; a heading wrapped onto a second line reads as one line', async () => {
    const prose = Array.from({ length: 12 }, () => body).join('\n\n');
    const txt = `BOOK FOURTH—SUCCOR FROM BELOW MAY TURN OUT TO BE SUCCOR FROM ON HIGH\n\n${prose}\n\nCHAPTER II—MOTHER PLUTARQUE FINDS NO DIFFICULTY IN EXPLAINING A\nPHENOMENON\n\n${prose}`;
    const r = await ingestBytes(enc(txt), 'b.txt');
    expect(r.manifest.toc.map((t) => t.t)).toEqual(['BOOK FOURTH—SUCCOR FROM BELOW MAY TURN OUT TO BE SUCCOR FROM ON HIGH', 'CHAPTER II—MOTHER PLUTARQUE FINDS NO DIFFICULTY IN EXPLAINING A PHENOMENON']);
    expect(r.blocks.filter((b) => b.k === 'h').map(blockText)[1]).not.toContain('\n');
  });

  it('a two-line paragraph starting "Part 2 of …" in wrapped text is not a heading', async () => {
    const p = (s: string) => s.replace(/(.{1,68})(\s|$)/g, '$1\n').trim();
    const prose = Array.from({ length: 30 }, () => p(body.replace(/\n/g, ' ')));
    prose[10] = 'Part 2 of the agreement says that the farmers keep the land along the\nriver and the mill.';
    const r = await ingestBytes(enc(prose.join('\n\n')), 'b.txt');
    expect(r.manifest.toc).toEqual([]);
    expect(r.blocks[10]).toMatchObject({ k: 'p' });
  });

  it('indented paragraphs, one a line: a heading doesn’t swallow the unindented first paragraph after it', async () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    let s = '';
    for (let c = 1; c <= 3; c++) {
      s += `CHAPTER ${c}\nThe first paragraph of chapter ${c} is not indented, as in printed books. ${words}.\n`;
      for (let k = 0; k < 6; k++) s += `\tAnother paragraph ${k} of chapter ${c}. ${words}.\n`;
    }
    const r = await ingestBytes(enc(s), 'b.txt');
    expect(r.manifest.toc.map((t) => t.t)).toEqual(['CHAPTER 1', 'CHAPTER 2', 'CHAPTER 3']);
    expect(blockText(r.blocks[1]).startsWith('The first paragraph of chapter 1')).toBe(true);
  });

  it('a title taken from the first line is stored like the text (composed)', async () => {
    const r = await ingestBytes(enc('Bo\u0308lu\u0308m Bir\n\nMetin.\n'), 'Untitled');
    expect(r.manifest.title).toBe('B\u00f6l\u00fcm Bir');
  });
});
