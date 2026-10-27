// The basics of a book's own CSS: italic, bold, small capitals, raised and
// lowered text, centred and right-aligned text, hidden text. From linked
// style sheets, <style> and style="". Fonts, sizes, colours and margins stay
// the reader's.

import { describe, expect, it, vi } from 'vitest';
import { PathIndex, type StyledElement, StyleSheet, parseDeclarations, styleOf } from '../src/engine/css';
import { BOLD, type Block, ITALIC, LINK, SMALLCAPS, SUB, SUP, blockText } from '../src/engine/types';
import { ingestBytes, makeEpub, xhtml } from './helpers';

const css = (sheet: string) => ({
  head: '<title>x</title><link rel="stylesheet" type="text/css" href="style.css"/>',
  files: { 'OEBPS/style.css': sheet },
  items: '<item id="css" href="style.css" media-type="text/css"/>',
});

async function blocksOf(body: string, sheet = '', head?: string) {
  const s = css(sheet);
  const { blocks } = await ingestBytes(makeEpub({ chapters: { 'a.xhtml': xhtml(body, head ?? s.head) }, files: s.files, items: s.items }), 'x.epub');
  return blocks;
}

describe('style sheets', () => {
  it('Calibre-style classes make italic and bold text', async () => {
    const b = await blocksOf(
      '<p class="calibre1">He said <span class="italic">never</span> and left.</p><p class="calibre1">The <span class="calibre5">Times</span> wrote it.</p>',
      '.italic { font-style: italic } .calibre5 { font-style: italic; font-weight: bold } .calibre1 { display: block; text-indent: 1.2em }',
    );
    expect(b[0].r).toEqual(['He said ', ['never ', ITALIC], 'and left.']);
    expect(b[1].r).toEqual(['The ', ['Times ', ITALIC | BOLD], 'wrote it.']);
  });

  it('element, element.class, several classes, ids, descendants and children', async () => {
    const b = await blocksOf(
      '<p class="a b">both</p><p class="a">one</p><div class="poem"><p>in poem</p></div><blockquote><p>quoted</p></blockquote><p id="x">by id</p><p><em class="plain">not italic</em></p>',
      '.a.b { font-weight: bold } p.a { font-style: italic } .poem p { font-style: italic } blockquote > p { font-variant: small-caps } #x { font-weight: 700 } em.plain { font-style: normal }',
    );
    expect(b.map((x) => x.r)).toEqual([
      [['both', BOLD | ITALIC]],
      [['one', ITALIC]],
      [['in poem', ITALIC]],
      [['quoted', SMALLCAPS]],
      [['by id', BOLD]],
      ['not italic'],
    ]);
  });

  it('font-style:normal and font-weight:normal undo inherited styling inside an element', async () => {
    const b = await blocksOf('<p class="it">Italic <span class="up">upright</span> again</p><h2>Head <span class="light">light</span></h2><p><b>bold <span style="font-weight:normal">not</span></b></p>', '.it { font-style: italic } .up { font-style: normal }');
    expect(b[0].r).toEqual([['Italic ', ITALIC], 'upright ', ['again', ITALIC]]);
    expect(b[2].r).toEqual([['bold ', BOLD], 'not']);
  });

  it('centred and right-aligned blocks, inherited, and undone by text-align:left', async () => {
    const b = await blocksOf(
      '<p class="c">Centred</p><div class="r"><p>Right</p><p class="l">Left</p></div><center>Old centre</center><p align="right">Old right</p><p>Plain</p>',
      '.c { text-align: center } .r { text-align: right } .l { text-align: justify }',
    );
    expect(b.map((x: Block) => [blockText(x), x.a])).toEqual([
      ['Centred', 'c'],
      ['Right', 'r'],
      ['Left', undefined],
      ['Old centre', 'c'],
      ['Old right', 'r'],
      ['Plain', undefined],
    ]);
  });

  it('display:none and the hidden attribute drop text; a hidden note someone links to stays', async () => {
    const b = await blocksOf(
      '<p>Seen<a href="#n1">1</a></p><p class="gone">Hidden <span>away</span></p><div hidden="hidden"><p>Also hidden</p><div>nested</div></div><p>After</p><aside class="gone" id="n1"><p>The note.</p></aside>',
      '.gone { display: none }',
    );
    expect(b.map(blockText)).toEqual(['Seen1', 'After', 'The note.']);
  });

  it('<style> in the head, style="" on the element (which wins), small caps', async () => {
    const b = await blocksOf('<p class="sc">Small caps</p><p class="sc" style="font-variant: normal">Not</p><p style="font: italic bold 1em serif">Short</p>', '', '<title>x</title><style>.sc { font-variant: small-caps }</style>');
    expect(b.map((x) => x.r)).toEqual([[['Small caps', SMALLCAPS]], ['Not'], [['Short', ITALIC | BOLD]]]);
  });

  it('class and id names in any alphabet, and escaped ones', async () => {
    const b = await blocksOf(
      '<p class="başlık">Kalın</p><p><span class="İtalik">eğik</span> düz</p><p id="bölüm1">Orta</p><p class="a.b">küçük</p><p class="10">on</p>',
      '.başlık { font-weight: bold } .İtalik { font-style: italic } #bölüm1 { text-align: center } .a\\.b { font-variant: small-caps } .\\31 0 { font-style: italic }',
    );
    expect(b.map((x) => [x.r, x.a])).toEqual([
      [[['Kalın', BOLD]], undefined],
      [[['eğik ', ITALIC], 'düz'], undefined],
      [['Orta'], 'c'],
      [[['küçük', SMALLCAPS]], undefined],
      [[['on', ITALIC]], undefined],
    ]);
  });

  it('vertical-align raises and lowers text a class styles (a note’s mark, a formula); baseline undoes <sup>', async () => {
    const b = await blocksOf(
      '<p>x<span class="up">2</span> H<span class="low">2</span>O <sup><span class="flat">not raised</span></sup></p><p>Word<a href="#n" class="fn">1</a></p><p id="n">Note.</p>',
      '.up { vertical-align: super } .low { vertical-align: sub } .flat { vertical-align: baseline } .fn { vertical-align: top }',
    );
    expect(b[0].r).toEqual(['x', ['2', SUP], ' H', ['2', SUB], 'O not raised']);
    expect(b[1].r).toEqual(['Word', ['1', SUP | LINK, 'OEBPS/a.xhtml#n']]);
  });

  it('media queries, font faces and selectors it can’t match are left out', async () => {
    const b = await blocksOf(
      '<p class="k">Kindle only hides this</p><p class="first">First</p><p>x</p>',
      '@font-face { font-family: X; src: url(x.ttf) } @media amzn-kf8 { .k { display: none } } p:first-child { font-style: italic } p[class] { font-weight: bold } .first::first-letter { font-weight: bold }',
    );
    expect(b.map((x) => x.r)).toEqual([['Kindle only hides this'], ['First'], ['x']]);
  });
});

describe('the cascade', () => {
  it('more specific rules win, later ones win among equals, style="" over all', () => {
    const s = new StyleSheet();
    s.add('p { font-style: italic } .x { font-style: normal } p { font-weight: bold } p { font-weight: normal }');
    const e = { name: 'p', classes: ['x'] };
    expect(styleOf([s], e, [], undefined)).toMatchObject({ set: 0, clear: ITALIC | BOLD });
    expect(styleOf([s], e, [], 'font-style: oblique')).toMatchObject({ set: ITALIC });
    expect(parseDeclarations('font-weight: 600; text-align: right; display: none')).toMatchObject({ set: BOLD, align: 'r', hidden: true });
  });
});

describe('undoing inherited styles', () => {
  it('display:none is undone by a more specific rule or style="" showing the element', async () => {
    const head = '<title>x</title><style>.a { display: none } .a.b { display: block } h1 span { display: none } h1 span.title { display: inline }</style>';
    const page = xhtml('<h1><span class="num">1</span> <span class="title">The Start</span></h1><p class="a">one</p><p class="a b">two</p><p class="a" style="display:block">three</p><p>four</p>', head);
    const { blocks } = await ingestBytes(makeEpub({ chapters: { 'c.xhtml': page } }), 'x.epub');
    expect(blocks.map(blockText)).toEqual(['The Start', 'two', 'three', 'four']);
  });

  it('text-align: inherit keeps the centre; the font shorthand resets what it leaves out', async () => {
    const b = await blocksOf('<div class="c"><p class="i">Centred</p></div><p class="it">Italic <span class="f">upright</span></p>', '.c { text-align: center } .i { text-align: inherit } .it { font-style: italic } .f { font: 1em serif }');
    expect(b[0].a).toBe('c');
    expect(b[1].r).toEqual([['Italic ', ITALIC], 'upright']);
  });
});

describe('style sheets and sloppy markup', () => {
  // (Counted, not timed: a busy machine made a timing fail.)
  let rules = '';
  for (let i = 0; i < 200; i++) rules += `.c${i} span { font-style: italic } div.x${i} p span.y { font-weight: bold }\n`;

  it('hundreds of unclosed elements and descendant rules: ancestors are looked at only for a rule that could match', () => {
    const sheet = new StyleSheet();
    sheet.add(rules);
    const index = new PathIndex();
    const path: StyledElement[] = [];
    let looked = 0;
    const counted = new Proxy(path, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) looked++;
        return Reflect.get(target, key, receiver);
      },
    });
    // 1000 <span class="s"> left open, one inside the other, as the converter sees them.
    for (let i = 0; i < 1000; i++) {
      const e: StyledElement = { name: 'span', classes: ['s'] };
      styleOf([sheet], e, counted, undefined, index);
      path.push(e);
      index.add(e, 1);
    }
    // Matching every rule against the open elements looked at 64 of them for each of
    // the 200 ".cN span" rules, for each element: twelve million in all (50 times slower).
    expect(looked).toBeLessThan(1000);
  });

  it('the converter tells the matching what the open elements have', async () => {
    const collect = vi.spyOn(StyleSheet.prototype, 'collect');
    try {
      const b = await blocksOf(`<p>${Array.from({ length: 1000 }, (_, i) => `<span class="s">word${i} `).join('')}</p>`, rules);
      expect(blockText(b[0]).startsWith('word0 word1 ')).toBe(true);
      expect(collect.mock.calls.length).toBeGreaterThan(1000);
      expect(collect.mock.calls.every((c) => c[4] instanceof PathIndex)).toBe(true);
    } finally {
      collect.mockRestore();
    }
  });
});
