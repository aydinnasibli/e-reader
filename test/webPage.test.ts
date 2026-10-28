// What the screen sends the reader page in the WebView: each block as HTML
// whose text is exactly its drawn text (so offsets on the page are drawn
// offsets), the look as CSS with the same values as the native text, and a
// frame whose columns land one page apart. And the page shipped is built
// from its sources (npm run build:page). The page itself is tested in real
// browser engines: bench/webpage.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A file system and bundled assets in memory, for the reading fonts' copies (webFonts.ts).
const disk = vi.hoisted(() => ({ files: new Map<string, string>(), assets: new Map<number, { hash: string; data: string }>(), fonts: new Map<string, unknown>() }));
vi.mock('react-native', () => ({ Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default } }));
vi.mock('@/lib/fonts', () => ({ fontFace: () => ({}), fontDef: (id: string) => disk.fonts.get(id) ?? { serif: true } }));
vi.mock('expo-asset', () => ({
  Asset: {
    fromModule: (m: number) => {
      const a = disk.assets.get(m)!;
      const asset = {
        hash: a.hash,
        localUri: null as string | null,
        async downloadAsync() {
          disk.files.set(`/cache/${m}-${a.hash}`, a.data);
          asset.localUri = `file:///cache/${m}-${a.hash}`;
          return asset;
        },
      };
      return asset;
    },
  },
}));
vi.mock('expo-file-system', () => {
  const pathOf = (base: unknown, name?: string) => {
    const p = typeof base === 'string' ? base.replace(/^file:\/\//, '') : (base as { path: string }).path;
    return name ? `${p}/${name}` : p;
  };
  class File {
    path: string;
    constructor(base: unknown, name?: string) {
      this.path = pathOf(base, name);
    }
    get exists() {
      return disk.files.has(this.path);
    }
    get uri() {
      return `file://${this.path}`;
    }
    get name() {
      return this.path.split('/').pop()!;
    }
    copySync(to: File) {
      disk.files.set(to.path, disk.files.get(this.path)!);
    }
    delete() {
      disk.files.delete(this.path);
    }
  }
  class Directory {
    path: string;
    constructor(base: unknown, name?: string) {
      this.path = pathOf(base, name);
    }
    get exists() {
      return true;
    }
    create() {}
    list() {
      return [...disk.files.keys()].filter((p) => p.startsWith(`${this.path}/`) && !p.slice(this.path.length + 1).includes('/')).map((p) => new File(p));
    }
  }
  return { File, Directory, Paths: { document: { path: '/doc' } } };
});

const { chunkHtml, chunkHtmlSliced, blockHtml, escapeHtml, joinsBefore } = await import('@/reader/web/html');
const { bookCss } = await import('@/reader/web/css');
const { webFrame, charWidth, toolBar, HEADER, MEASURE } = await import('@/reader/web/frame');
const { sanitizeSettings, THEMES } = await import('@/lib/settings');
const { drawn, lookOf, runTextStyle } = await import('@/reader/look');
const { CHUNK_CHARS } = await import('@/engine/writer');
const { SMALLCAPS } = await import('@/engine/types');
const { parseChunk } = await import('./ui/fakePage');
type Block = import('@/engine/types').Block;

const settings = sanitizeSettings({ hyphenate: true, indent: true, fontSize: 20, lineSpacing: 1.5 });
const phone = { width: 393, height: 852 };
const upright = { top: 47, bottom: 34, left: 0, right: 0 };

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
    // The indent: an em space and an en space (look.ts).
    expect(parsed[1].text.startsWith('\u2003\u2002')).toBe(true);
    expect(parsed[1].text).toContain('­');
  });

  it('marks up headings, styles and footnote links; escapes the text', () => {
    const plain = html.replace(/­/g, '');
    expect(plain).toContain('<h2 data-b="100" class="h2">Chapter &lt;One&gt; &amp; &quot;Two&quot;</h2>');
    // (The note mark straight after the word stays on the line with its last letter.)
    expect(plain).toContain('<span class="i">Ishmae</span><span class="nw"><span class="i">l</span><span class="sup a" data-link="n1">¹</span></span>');
  });

  it('a paragraph stored in several blocks is one paragraph: each block an inline part of it', () => {
    // (Each block used to be a paragraph of its own: the line before each joint ended short.)
    expect(html.replace(/­/g, '')).toMatch(/^<h2[^>]*>.*<\/h2><div data-w class="p"><p data-b="101">.*<\/p><p data-b="102">a continued paragraph<\/p><\/div><div data-b="103"/);
  });

  it('the rest of a paragraph starting a chunk is marked as going on from the chunk before', () => {
    const rest = chunkHtml([{ k: 'p', c: 1, r: ['rest of it'] }, { k: 'p', r: ['Next.'] }], 7, settings, 'en', new Map());
    expect(rest).toMatch(/^<div data-w class="p c"><p data-b="7">rest of it<\/p><\/div><p data-b="8" class="p">/);
  });

  it("the book's own alignment and small capitals", () => {
    const styled = chunkHtml([{ k: 'p', a: 'c', r: ['* * *'] }, { k: 'p', a: 'r', r: [['Signed', SMALLCAPS]] }], 0, settings, 'en', new Map());
    expect(styled).toContain('<p data-b="0" class="p ac">* * *</p>');
    expect(styled).toContain('<p data-b="1" class="p ar"><span class="sc">Signed</span></p>');
    // No indent on a centred or right-aligned paragraph, on the page as in the native previews.
    expect(lookOf({ k: 'p', a: 'c', r: ['x'] }, settings)).toMatchObject({ textAlign: 'center', prefix: '' });
    expect(lookOf({ k: 'v', a: 'r', r: ['x'] }, settings)).toMatchObject({ textAlign: 'right' });
    expect(runTextStyle(SMALLCAPS, lookOf({ k: 'p', r: ['x'] }, settings))).toMatchObject({ fontVariant: ['small-caps'] });
  });

  it('a NUL or a carriage return stays one character, so later offsets hold (the HTML parser drops one and merges the other)', () => {
    expect(escapeHtml('a\u0000b\r\nc<d')).toBe('a�b \nc&lt;d');
    const p = parseChunk(blockHtml({ k: 'p', r: ['x\u0000y'] }, 3, settings, 'en'))[0];
    expect(p.text.length).toBe(drawn({ k: 'p', r: ['x\u0000y'] }, lookOf({ k: 'p', r: ['x\u0000y'] }, settings, 'en')).text.length);
  });

  it('pictures keep their size (for a stable layout), their shape, never over twice it, as wide as the column and as high as a page at most', () => {
    expect(html).toContain('<img src="file:///img/c.png" width="300" height="400" style="width:min(100%,600px,calc(var(--page-h) * 0.75));height:auto"');
    expect(blockHtml({ k: 'img', s: 'x' }, 7, settings, 'en', null)).toBe('<div data-b="7" class="img"></div>');
  });

  it("a footnote mark never starts a line: the space before it doesn't break, one straight after a word stays with its last letter", () => {
    const plain = { ...settings, hyphenate: false, indent: false };
    const note = (r: Block['r']) => blockHtml({ k: 'p', r }, 0, plain, 'en');
    // EPUB: a link; FB2: a superscript link. A space before it: drawn as one that doesn't break, one character for one.
    const spaced: Block['r'] = ['as the sea ', ['[12]', 32, 'n12'], ' went on'];
    expect(note(spaced)).toBe('<p data-b="0" class="p">as the sea <span class="a" data-link="n12">[12]</span> went on</p>');
    expect(parseChunk(note(spaced))[0].text.length).toBe('as the sea [12] went on'.length);
    expect(note(['the end ', ['3', 8]])).toContain('end <span class="sup">3</span>');
    // Straight after a word (and its full stop): the stop and the mark on one line.
    expect(note(['the end.', ['¹', 8 | 32, 'n1'], ' Then'])).toBe('<p data-b="0" class="p">the end<span class="nw">.<span class="sup a" data-link="n1">¹</span></span> Then</p>');
    expect(note([['Ishmael', 2], ['²', 8 | 32, 'n2']])).toBe('<p data-b="0" class="p"><span class="i">Ishmae</span><span class="nw"><span class="i">l</span><span class="sup a" data-link="n2">²</span></span></p>');
    // Not a mark: a long link, or an ordinary run, are left as they are.
    expect(note(['see ', ['the next chapter', 32, 'ch2']])).toBe('<p data-b="0" class="p">see <span class="a" data-link="ch2">the next chapter</span></p>');
    expect(note(['plain text'])).toBe('<p data-b="0" class="p">plain text</p>');
  });

  it('a chunk can be made a paragraph at a time, with a pause between them: the same HTML', async () => {
    let pauses = 0;
    const sliced = await chunkHtmlSliced(blocks, 100, settings, 'en', new Map([['cover.png', { uri: 'file:///img/c.png', width: 300, height: 400 }]]), async () => {
      pauses++;
    });
    expect(sliced).toBe(html);
    // The heading, the paragraph in two parts, the empty line, the rule, the picture.
    expect(pauses).toBe(5);
  });
});

describe('chunks laid out on from the one before (Chunk.joins)', () => {
  // Chunk 0 a chapter; chunks 1-5 a chapter cut into five for size; 6-7 a chapter cut in two (6 at 600 blocks).
  const chars = [9_000, CHUNK_CHARS, CHUNK_CHARS + 120, CHUNK_CHARS, CHUNK_CHARS + 900, 12_000, 4_000, 3_000];
  const blocks = (x: number) => (x === 6 ? 600 : 300);
  it("in pairs from a chapter's first chunk, so a page never depends on more than the chunk before it", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((c) => joinsBefore(c, (x) => chars[x], blocks))).toEqual([false, false, true, false, true, false, false, true]);
  });
  it('a chunk ending at a chapter never joins the next (chapters start a page of their own)', () => {
    expect(joinsBefore(1, () => 29_000, () => 100)).toBe(false);
    // ...unless it was cut for its blocks (600) rather than characters.
    expect(joinsBefore(1, () => 9_000, () => 600)).toBe(true);
  });
  it("a chapter starts a page of its own even when the one before ended right at the size limit: the converter says where chapters start", async () => {
    const { BookWriter } = await import('@/engine/writer');
    const { MemorySink } = await import('./helpers');
    const sink = new MemorySink();
    const w = new BookWriter(sink);
    const chapter = (title: string, paragraphs: number) => {
      w.chapterBreak();
      w.setKind('h', 1);
      w.text(title);
      w.endBlock();
      for (let k = 0; k < paragraphs; k++) {
        w.setKind('p');
        w.text(`${'x'.repeat(999)}.`);
        w.endBlock();
      }
    };
    // Chapter one's 30 paragraphs of 1,000 characters fill its chunk exactly; chapter two takes two chunks.
    chapter('Chapter One', 30);
    chapter('Chapter Two', 35);
    w.finish();
    const opens = sink.infos.flatMap((x, i) => (x.opens ? [i] : []));
    const size = [(x: number) => sink.infos[x].chars, (x: number) => sink.infos[x].blocks] as const;
    expect(JSON.parse(sink.chunks[1]).b[0]).toMatchObject({ k: 'h', r: ['Chapter Two'] });
    expect(opens).toEqual([1]);
    // Told by size alone (a book converted before chapters were told), chapter two would go on from chapter one.
    expect(joinsBefore(1, ...size)).toBe(true);
    expect(joinsBefore(1, ...size, opens)).toBe(false);
    // Chapter two's second chunk, cut for size, goes on from its first.
    expect(joinsBefore(2, ...size, opens)).toBe(true);
  });
});

describe('the look as CSS', () => {
  const frame = webFrame(phone, upright, 20, 'page');
  const font = { css: '@font-face{x}', family: "'nec-lora', serif", medium: true };
  const css = bookCss(settings, THEMES.sepia, frame, font, 'page');

  it('uses the same values as the native text', () => {
    const p = lookOf({ k: 'p', r: [''] }, settings);
    expect(css).toContain(`.p{font-size:${p.fontSize}px;line-height:${p.lineHeight}px;`);
    expect(css).toContain(`text-align:${p.textAlign};margin-top:${p.marginTop}px;`);
    const h1 = lookOf({ k: 'h', l: 1, r: [''] }, settings);
    expect(css).toContain(`.h1{font-size:${h1.fontSize}px;`);
    expect(css).toContain('font-weight:700');
    // The book's own alignment wins over the kind's (it comes after).
    expect(css.indexOf('.ac{text-align:center;}')).toBeGreaterThan(css.indexOf('.p{'));
    expect(css).toContain('.sc{font-variant-caps:small-caps;}');
  });

  it('the theme, the font and the page columns', () => {
    expect(css).toContain(`html,body{background:${THEMES.sepia.bg};color:${THEMES.sepia.text};}`);
    expect(css.startsWith('@font-face{x}')).toBe(true);
    expect(css).toContain(`#strip>.chunk{width:${frame.width}px;height:${frame.height}px;padding:0 ${frame.right}px 0 ${frame.left}px;column-width:${frame.column}px;column-gap:${frame.gap}px;}`);
    const p = lookOf({ k: 'p', r: [''] }, settings);
    expect(css).toContain(`:root{--page-h:${frame.height}px;--line:${p.lineHeight}px;--gap:${p.marginTop}px;}`);
  });

  it('only the font faces the text uses: its weight and bold', () => {
    const face = (weight: number, style: string) => ({ weight, css: `@font-face{w:${weight};s:${style}}` });
    const faces = [face(400, 'normal'), face(400, 'italic'), face(700, 'normal'), face(700, 'italic'), face(500, 'normal'), face(500, 'italic')];
    const withFaces = { ...font, css: faces.map((f) => f.css).join(''), faces };
    const regular = bookCss(settings, THEMES.light, frame, withFaces, 'page');
    expect(regular.match(/@font-face\{[^}]*\}/g)).toEqual(['@font-face{w:400;s:normal}', '@font-face{w:400;s:italic}', '@font-face{w:700;s:normal}', '@font-face{w:700;s:italic}']);
    const medium = bookCss(sanitizeSettings({ ...settings, weight: 'medium' }), THEMES.light, frame, withFaces, 'page');
    expect(medium.match(/w:(\d+)/g)).toEqual(['w:700', 'w:700', 'w:500', 'w:500']);
  });

  it('a heading keeps room under it: what the page measures follows it (--keep), until then the space after it and three lines', () => {
    const h3 = lookOf({ k: 'h', l: 3, r: [''] }, settings);
    const p = lookOf({ k: 'p', r: [''] }, settings);
    const keep = `var(--keep,${Math.max(h3.marginBottom, p.marginTop) + 3 * p.lineHeight + 1}px)`;
    expect(css).toContain(`.h3::after{height:${keep};margin-bottom:calc(${keep} * -1);}`);
  });

  it('landscape: pages drawn between the notch and the camera', () => {
    const f = webFrame({ width: 852, height: 393 }, { top: 0, bottom: 21, left: 59, right: 59 }, 20, 'page');
    const land = bookCss(settings, THEMES.light, f, font, 'page');
    expect(land).toContain("html[data-mode='page'] #viewport{left:59px;width:734px;right:auto;}");
    expect(land).toContain(`#strip>.chunk{width:734px;height:${f.height}px;padding:0 20px 0 20px;`);
  });
});

describe('where the text goes', () => {
  it('a phone: one column a screen, between the header and the footer', () => {
    const f = webFrame(phone, upright, 20, 'page');
    expect(f).toMatchObject({ width: 393, height: 852 - 47 - 34 - 60, left: 20, right: 20, spread: false });
    // One column and its gap make exactly a screen: page n is n screens along.
    expect(f.column + f.gap).toBe(393);
  });

  it('a phone held upright is the same with the text given (lines there are well under the cap)', () => {
    for (const fontSize of [12, 19, 40]) {
      expect(webFrame(phone, upright, 20, 'page', { fontSize, font: 'literata' })).toEqual(webFrame(phone, upright, 20, 'page'));
      expect(webFrame({ width: 430, height: 932 }, upright, 20, 'scroll', { fontSize, font: 'garamond' })).toEqual(webFrame({ width: 430, height: 932 }, upright, 20, 'scroll'));
    }
  });

  it('landscape on a wide screen: two pages a screen, clear of the camera cutout, the middle just the margins', () => {
    const f = webFrame({ width: 852, height: 393 }, { top: 0, bottom: 21, left: 47, right: 47 }, 20, 'page');
    expect(f.spread).toBe(true);
    // Two pages make the screen between the insets: (852 - 94) / 2 each.
    expect(f.column + f.gap).toBe((852 - 94) / 2);
    expect(f.left).toBe(67);
    expect(f.right).toBe(67);
    // The middle of the spread: the right margin of one page and the left of the next.
    expect(f.gap).toBe(40);
    expect(f.inset).toEqual({ left: 47, right: 47 });
  });

  it('the camera on one side only (Android): the pages keep clear of it, the other side has just the margin', () => {
    const f = webFrame({ width: 914, height: 411 }, { top: 0, bottom: 16, left: 0, right: 48 }, 20, 'page');
    expect(f).toMatchObject({ left: 20, right: 68, gap: 40, spread: true, inset: { left: 0, right: 48 } });
    expect(2 * (f.column + f.gap)).toBe(914 - 48);
  });

  it('wide screens: a line holds about 70 characters (wider margins), two pages side by side where both lines stay long', () => {
    const type = { fontSize: 19, font: 'serif' };
    const cap = MEASURE * charWidth(type);
    // A tablet upright: one page, centred, margins wider.
    const tablet = webFrame({ width: 820, height: 1180 }, { top: 24, bottom: 20, left: 0, right: 0 }, 20, 'page', type);
    expect(tablet.spread).toBe(false);
    expect(tablet.column).toBeCloseTo(cap, 5);
    expect(tablet.left).toBeCloseTo((820 - cap) / 2, 5);
    expect(tablet.column + tablet.gap).toBe(820);
    // A big tablet upright: two pages, each line still long.
    const big = webFrame({ width: 1024, height: 1366 }, { top: 24, bottom: 20, left: 0, right: 0 }, 20, 'page', type);
    expect(big.spread).toBe(true);
    expect(big.column).toBe(1024 / 2 - 40);
    // Landscape on a big tablet: two pages, capped.
    const land = webFrame({ width: 1376, height: 1032 }, { top: 24, bottom: 20, left: 0, right: 0 }, 20, 'page', type);
    expect(land.spread).toBe(true);
    expect(land.column).toBeCloseTo(cap, 5);
    expect(2 * (land.column + land.gap)).toBe(1376);
    // Scroll mode: a centred column.
    const scroll = webFrame({ width: 852, height: 393 }, { top: 0, bottom: 21, left: 59, right: 59 }, 20, 'scroll', type);
    expect(scroll.column).toBeCloseTo(cap, 5);
    expect(scroll.left).toBeCloseTo(scroll.right, 5);
    // A bigger text size: the column grows with it.
    expect(webFrame({ width: 820, height: 1180 }, upright, 20, 'page', { fontSize: 24 }).column).toBeCloseTo(MEASURE * charWidth({ fontSize: 24 }), 5);
  });

  it('scroll mode: the whole screen, clear of the status bar and the badge', () => {
    const f = webFrame(phone, upright, 20, 'scroll');
    expect(f).toMatchObject({ width: 393, height: 852, top: 59, bottom: 74, column: 353 });
  });

  it("the highlight tool's bar: page mode over the header, its buttons touched up into the status bar's room; scroll mode a full row the text goes below", () => {
    // Upright: the header's row, touched from 44 up.
    expect(toolBar(59, 'page')).toEqual({ height: 59 + HEADER, row: HEADER, reach: 44 });
    // Landscape, no room above: up to the screen's edge.
    expect(toolBar(0, 'page')).toEqual({ height: HEADER, row: HEADER, reach: HEADER });
    expect(toolBar(59, 'scroll')).toEqual({ height: 59 + 44, row: 44, reach: 44 });
  });
});

describe('reading fonts copied where the page can read them', () => {
  beforeEach(() => {
    vi.resetModules();
    disk.files.clear();
    disk.assets.clear();
    disk.fonts.clear();
  });
  const install = (hash: string) => {
    disk.assets.set(1, { hash: `${hash}r`, data: `regular ${hash}` });
    disk.assets.set(2, { hash: `${hash}i`, data: `italic ${hash}` });
    disk.fonts.set('atkinson', { serif: false, files: { regular: 1, italic: 2 } });
  };
  const copies = () => [...disk.files.keys()].filter((p) => p.startsWith('/doc/webfonts/')).sort();

  it('a copy is named after what is in it: a font file changed by an update is copied again, the old copy deleted', async () => {
    install('a');
    const first = await (await import('@/reader/web/webFonts')).webFont('atkinson');
    expect(copies()).toEqual(['/doc/webfonts/atkinson-italic-ai.ttf', '/doc/webfonts/atkinson-regular-ar.ttf']);
    expect(first.faces?.map((f) => f.weight)).toEqual([400, 400]);
    // Copies made by the version before names had the file's hash, and other fonts' copies.
    disk.files.set('/doc/webfonts/atkinson-regular.ttf', 'old');
    disk.files.set('/doc/webfonts/lora-regular-x.ttf', 'lora');
    // The app updated with a new Atkinson (Atkinson Hyperlegible Next): same font, other files.
    vi.resetModules();
    install('b');
    const next = await (await import('@/reader/web/webFonts')).webFont('atkinson');
    expect(copies()).toEqual(['/doc/webfonts/atkinson-italic-bi.ttf', '/doc/webfonts/atkinson-regular-br.ttf', '/doc/webfonts/lora-regular-x.ttf']);
    expect(disk.files.get('/doc/webfonts/atkinson-regular-br.ttf')).toBe('regular b');
    expect(next.css).toContain("src:url('file:///doc/webfonts/atkinson-regular-br.ttf')");
  });
});

it('the page shipped is built from its current sources (run npm run build:page)', async () => {
  const { sourceHash } = await import('../scripts/build-reader-page.mjs');
  const generated = readFileSync(new URL('../src/reader/web/page.generated.ts', import.meta.url), 'utf8');
  expect(generated).toContain(`PAGE_SOURCE_HASH = '${sourceHash()}'`);
});
