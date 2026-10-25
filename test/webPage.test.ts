// What the screen sends the reader page in the WebView: each block as HTML
// whose text is exactly its drawn text (so offsets on the page are drawn
// offsets), the look as CSS with the same values as the native text, and a
// frame whose columns land one page apart. And the page shipped is built
// from its sources (npm run build:page). The page itself is tested in real
// browser engines: bench/webpage.

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default } }));
vi.mock('@/lib/fonts', () => ({ fontFace: () => ({}), fontDef: () => ({ serif: true }) }));
vi.mock('expo-asset', () => ({ Asset: {} }));
vi.mock('expo-file-system', () => ({ File: class {}, Directory: class {}, Paths: {} }));

const { chunkHtml, blockHtml } = await import('@/reader/web/html');
const { bookCss } = await import('@/reader/web/css');
const { webFrame } = await import('@/reader/web/frame');
const { sanitizeSettings, THEMES } = await import('@/lib/settings');
const { drawn, lookOf } = await import('@/reader/look');
const { parseChunk } = await import('./ui/fakePage');
type Block = import('@/engine/types').Block;

const settings = sanitizeSettings({ hyphenate: true, indent: true, fontSize: 20, lineSpacing: 1.5 });

describe('blocks as HTML', () => {
  const blocks: Block[] = [
    { k: 'h', l: 2, r: ['Chapter <One> & "Two"'] },
    { k: 'p', r: ['Call me ', ['Ishmael', 2], ['¹', 8 | 32, 'n1'], ' unquestionably.'] },
    { k: 'p', c: 1, r: ['a continued paragraph'] },
    { k: 'sp' },
    { k: 'hr' },
    { k: 'img', s: 'cover.png' },
  ];
  const html = chunkHtml(blocks, 100, settings, 'en', new Map([['cover.png', { uri: 'file:///img/c.png', width: 300, height: 400 }]]));

  it("each block's text is exactly its drawn text: the indent and soft hyphens included", () => {
    const parsed = parseChunk(html);
    expect(parsed.map((p) => p.b)).toEqual([100, 101, 102, 103, 104, 105]);
    for (const [k, blk] of blocks.entries()) {
      if (!blk.r) continue;
      expect(parsed[k].text).toBe(drawn(blk, lookOf(blk, settings, 'en')).text);
    }
    expect(parsed[1].text.startsWith('  ')).toBe(true);
    expect(parsed[1].text).toContain('­');
  });

  it('marks up headings, styles and footnote links; escapes the text', () => {
    const plain = html.replace(/\u00ad/g, '');
    expect(plain).toContain('<h2 data-b="100" class="h2">Chapter &lt;One&gt; &amp; &quot;Two&quot;</h2>');
    expect(plain).toContain('<span class="i">Ishmael</span>');
    expect(html).toContain('<span class="sup a" data-link="n1">¹</span>');
    expect(html).toContain('<p data-b="102" class="p c">');
  });

  it('pictures keep their size (for a stable layout) and are never shown over twice it', () => {
    expect(html).toContain('<img src="file:///img/c.png" width="300" height="400" style="max-width:min(100%,600px)"');
    expect(blockHtml({ k: 'img', s: 'x' }, 7, settings, 'en', null)).toBe('<div data-b="7" class="img"></div>');
  });
});

describe('the look as CSS', () => {
  const frame = webFrame({ width: 393, height: 852 }, { top: 47, bottom: 34, left: 0, right: 0 }, 20, 'page');
  const css = bookCss(settings, THEMES.sepia, frame, { css: '@font-face{x}', family: "'nec-lora', serif", medium: true }, 'page');

  it('uses the same values as the native text', () => {
    const p = lookOf({ k: 'p', r: [''] }, settings);
    expect(css).toContain(`.p{font-size:${p.fontSize}px;line-height:${p.lineHeight}px;`);
    expect(css).toContain(`text-align:${p.textAlign};margin-top:${p.marginTop}px;`);
    const h1 = lookOf({ k: 'h', l: 1, r: [''] }, settings);
    expect(css).toContain(`.h1{font-size:${h1.fontSize}px;`);
    expect(css).toContain('font-weight:700');
  });

  it('the theme, the font and the page columns', () => {
    expect(css).toContain(`html,body{background:${THEMES.sepia.bg};color:${THEMES.sepia.text};}`);
    expect(css.startsWith('@font-face{x}')).toBe(true);
    expect(css).toContain(`#strip>.chunk{width:${frame.width}px;height:${frame.height}px;padding:0 ${frame.right}px 0 ${frame.left}px;column-width:${frame.column}px;column-gap:${frame.gap}px;}`);
  });
});

describe('where the text goes', () => {
  it('a phone: one column a screen, between the header and the footer', () => {
    const f = webFrame({ width: 393, height: 852 }, { top: 47, bottom: 34, left: 0, right: 0 }, 20, 'page');
    expect(f).toMatchObject({ width: 393, height: 852 - 47 - 34 - 60, left: 20, right: 20, spread: false });
    // One column and its gap make exactly a screen: page n is n screens along.
    expect(f.column + f.gap).toBe(393);
  });

  it('landscape on a wide screen: two pages a screen, clear of the camera cutout', () => {
    const f = webFrame({ width: 852, height: 393 }, { top: 0, bottom: 21, left: 47, right: 47 }, 20, 'page');
    expect(f.spread).toBe(true);
    expect(f.column + f.gap).toBe(852 / 2);
    expect(f.left).toBe(67);
  });

  it('scroll mode: the whole screen, clear of the status bar and the badge', () => {
    const f = webFrame({ width: 393, height: 852 }, { top: 47, bottom: 34, left: 0, right: 0 }, 20, 'scroll');
    expect(f).toMatchObject({ width: 393, height: 852, top: 59, bottom: 74, column: 353 });
  });
});

it('the page shipped is built from its current sources (run npm run build:page)', async () => {
  const { sourceHash } = await import('../scripts/build-reader-page.mjs');
  const generated = readFileSync(new URL('../src/reader/web/page.generated.ts', import.meta.url), 'utf8');
  expect(generated).toContain(`PAGE_SOURCE_HASH = '${sourceHash()}'`);
});
