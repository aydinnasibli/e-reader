// The reader page (src/reader/web/page) in real browser engines: Chromium
// (Android's WebView) and WebKit (the iPhone's), fed with HTML and CSS made by
// the app's own code. Checks what the screen relies on: page continuity (every
// page starts where the last ended, and that text is really on screen), jumps,
// reopening at a page's start, staying on the place after a text size change,
// a web font that loads late or a picture that changes shape, selection,
// marks, touches, the highlight tool, spreads, scroll mode. And what was
// fixed since: turns racing chunks coming and going, chunks laid out on from
// the one before, auto-scroll, pictures' shapes, long paragraphs in parts, lone
// lines and headings at a page's foot, the book's language, font loading,
// footnote marks, the book's own styles, selections to a block's edge,
// touches that aren't turns, the place at the top in scroll mode, spreads
// between the insets, line length on wide screens, moves that aren't reading
// on, chunks measured out of sight, verse and kept line breaks; and what a
// review found: headings as tall as a page, headings followed by headings or
// pictures, a chunk's last paragraph joined by the next chunk, a turn while a
// font loads, highlights after two layout changes, auto-scroll waiting for a
// chunk; pages always cut the same way (the line read marked), rapid taps.
//
//   npx playwright-core install chromium webkit   # once
//   npm run test:page                             # both engines
//   ENGINE=webkit node bench/webpage/run.mjs      # one
//   PAGE_FILE=old.html node bench/webpage/run.mjs # another build of the page (e.g. to see a check fail before its fix)

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const OUT = join(ROOT, 'bench/.out');
mkdirSync(OUT, { recursive: true });
const ENGINE = process.env.ENGINE ?? 'chromium';

// The app's own HTML/CSS code, bundled for Node with the phone-only modules stubbed.
const S = join(HERE, 'stubs');
await build({
  entryPoints: [join(HERE, 'gen.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: join(OUT, 'webpage-gen.mjs'),
  logLevel: 'warning',
  absWorkingDir: ROOT,
  tsconfig: join(ROOT, 'tsconfig.json'),
  loader: { '.ttf': 'empty' },
  alias: { 'react-native': join(S, 'react-native.js'), 'expo-font': join(S, 'expo-font.js'), 'expo-file-system': join(S, 'expo-file-system.js'), 'expo-asset': join(S, 'expo-asset.js') },
});
const gen = await import(join(OUT, 'webpage-gen.mjs'));

/** Playwright's own browser, or any Chromium it downloaded before (CHROME= to choose one). */
function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(process.env.HOME ?? '', 'Library/Caches/ms-playwright');
  try {
    for (const d of readdirSync(cache).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      const app = join(cache, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
      if (existsSync(app)) return app;
    }
  } catch {
    // no cache
  }
  return undefined;
}
const src = readFileSync(`${ROOT}/src/reader/web/page.generated.ts`, 'utf8');
const PAGE_HTML = JSON.parse(src.match(/export const PAGE_HTML = (".*");/)[1]);
const PAGE_FILE = process.env.PAGE_FILE ?? join(OUT, 'webpage.html');
if (!process.env.PAGE_FILE) writeFileSync(PAGE_FILE, PAGE_HTML);

let failures = 0;
const ok = (cond, msg) => {
  if (!cond) failures++;
  console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`);
};

// ---- a book: three chunks of mixed blocks ----
const words = 'the sea was calm and the sky was wide while the ship went quietly on through a long and starless night toward harbours nobody aboard had ever seen'.split(' ');
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function para(k) {
  const n = 30 + Math.floor(rnd() * 70);
  const ws = [];
  for (let i = 0; i < n; i++) ws.push(words[Math.floor(rnd() * words.length)]);
  const text = `§${k} ` + ws.join(' ') + '.';
  if (k % 7 === 3) {
    const cut = text.indexOf(' ', 20);
    return { k: 'p', r: [text.slice(0, cut), [' in italic words', 2], [' and bold', 1], ['¹', 8 | 32, 'note1'], text.slice(cut)] };
  }
  return { k: 'p', r: [text] };
}
function chunkBlocks(c) {
  const out = [];
  for (let i = 0; i < 80; i++) {
    const k = c * 80 + i;
    if (i === 0) out.push({ k: 'h', l: 2, r: [`Chapter ${c + 1}`] });
    else if (i % 25 === 0) out.push({ k: 'hr' });
    else if (i % 31 === 0) out.push({ k: 'v', r: ['A line of verse that stays on the left'] });
    else out.push(para(k));
  }
  return out;
}
const CHUNKS = [0, 1, 2].map(chunkBlocks);
const chunkStart = (c) => c * 80;
const chars = (blocks) => blocks.reduce((n, b) => n + (b.r ?? []).reduce((m, r) => m + (typeof r === 'string' ? r : r[0]).length, 0), 0);

function chunk(c, settings) {
  return { c, html: gen.chunkHtml(CHUNKS[c], chunkStart(c), settings, 'en', new Map()), chars: chars(CHUNKS[c]) };
}
const INSETS = { portrait: { top: 47, bottom: 34, left: 0, right: 0 }, landscape: { top: 0, bottom: 21, left: 47, right: 47 } };
const insetsOf = (screen) => (screen.width > screen.height ? INSETS.landscape : INSETS.portrait);
const frameOf = (mode, settings, screen) => gen.webFrame(screen, insetsOf(screen), settings.margin, mode);
const SYSTEM_FONT = { css: '', family: 'Georgia, serif', medium: false };
function setupMsg(mode, settings, screen, target, key, font = SYSTEM_FONT, { turn = 'none', lang, theme = gen.THEMES.light, frame = frameOf(mode, settings, screen) } = {}) {
  return { t: 'setup', key, target, setup: { mode, frame, css: gen.bookCss(settings, theme, frame, font, mode), turn, tapForward: false, processing: 'Preparing…', theEnd: '— The End —', lang } };
}
const before = (a, b) => a.b < b.b || (a.b === b.b && a.i < b.i);
const same = (a, b) => a && b && a.b === b.b && a.i === b.i;

async function open(win, { touch = true, dpr = 3 } = {}) {
  const browser = ENGINE === 'webkit' ? await webkit.launch() : await chromium.launch({ executablePath: chromePath(), headless: true });
  const ctx = await browser.newContext({ viewport: win, hasTouch: touch, isMobile: true, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.addInitScript(() => {
    window.__out = [];
    window.ReactNativeWebView = { postMessage: (d) => window.__out.push(JSON.parse(d)) };
  });
  await page.goto('file://' + PAGE_FILE);
  const send = (m) => page.evaluate((m) => window.__nec(m), m);
  const take = async (wait = 80) => {
    await page.waitForTimeout(wait);
    return page.evaluate(() => window.__out.splice(0));
  };
  return { browser, page, send, take };
}
const lastOf = (msgs, t) => [...msgs].reverse().find((m) => m.t === t);

/** The colour drawn at a point of the page: [r, g, b] (a 1×1 screenshot, decoded). */
async function pixel(page, x, y) {
  const png = await page.screenshot({ clip: { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 }, scale: 'css' });
  const idat = [];
  for (let o = 8; o < png.length; ) {
    const len = png.readUInt32BE(o);
    const type = png.toString('ascii', o + 4, o + 8);
    if (type === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  // One pixel: whatever the row's filter, its bytes are the colour.
  const raw = inflateSync(Buffer.concat(idat));
  return [raw[1], raw[2], raw[3]];
}
const yellowish = ([r, g, b]) => r > 200 && g > 190 && b < 150;

/** Where character `i` of block `b` is drawn: its middle. */
const charAt = (page, b, i) =>
  page.evaluate(({ b, i }) => {
    const el = document.querySelector(`[data-b="${b}"]`);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let left = i;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (left < n.data.length) {
        const r = document.createRange();
        r.setStart(n, left);
        r.setEnd(n, left + 1);
        const box = r.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      }
      left -= n.data.length;
    }
    return null;
  }, { b, i });

// What the page really shows: is a drawn point's character inside the screen
// (page mode: inside the part of it pages are drawn in, between the side insets)?
async function visible(page, p) {
  return page.evaluate((p) => {
    const el = document.querySelector(`[data-b="${p.b}"]`);
    if (!el) return null;
    const vp = document.documentElement.dataset.mode === 'page' ? document.getElementById('viewport').getBoundingClientRect() : { left: 0, right: innerWidth };
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let left = p.i;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (left < n.data.length) {
        const r = document.createRange();
        r.setStart(n, left);
        r.setEnd(n, left + 1);
        const box = [...r.getClientRects()].find((x) => x.height > 0);
        if (!box) return 'invisible';
        return box.left >= vp.left - 1 && box.right <= vp.right + 1 && box.top >= -1 && box.bottom <= innerHeight + 1;
      }
      left -= n.data.length;
    }
    // An element without text (a rule, an image).
    const r = el.getBoundingClientRect();
    return r.left >= vp.left - 1 && r.left < vp.right;
  }, p);
}

async function pagedTest(screen, label) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true });
  const f = frameOf('page', settings, screen);
  const win = { width: f.width, height: f.height };
  console.log(`\npage mode, ${label}: screen ${screen.width}×${screen.height}, page ${win.width}×${win.height}${f.spread ? ', spread' : ''}`);
  const { browser, page, send, take } = await open(win);
  await take(0);
  await send(setupMsg('page', settings, screen, { at: { b: 0, i: 0 } }, 'k1'));
  await send({ t: 'bounds', count: 3, complete: true });
  await send({ t: 'content', chunks: [0, 1, 2].map((c) => chunk(c, settings)), target: { at: { b: 0, i: 0 } }, key: 'k1' });
  let msgs = await take(200);
  const first = lastOf(msgs, 'shown');
  ok(first && same(first.first, { b: 0, i: 0 }), `opens on the first page: ${JSON.stringify(first?.first)}`);
  const pages = lastOf(msgs, 'pages');
  const total = pages ? pages.counts.reduce((n, c) => n + Math.ceil(c.pages / (f.spread ? 2 : 1)), 0) : 0;
  ok(pages && pages.counts.length === 3 && pages.counts.every((c) => c.pages > 3), `pages per chunk: ${JSON.stringify(pages?.counts.map((c) => c.pages))}`);

  // Turn through every page: each starts exactly where the last one said the next would.
  let prev = first;
  let gaps = 0;
  let hidden = 0;
  let turns = 0;
  const starts = [first.first];
  for (; turns < total + 2; turns++) {
    await send({ t: 'turn', dir: 1 });
    msgs = await take(30);
    const s = lastOf(msgs, 'shown');
    if (!s) {
      ok(msgs.some((m) => m.t === 'end'), `the last page: a further turn says the book ends (after ${turns} turns)`);
      break;
    }
    if (!same(prev.next, s.first)) {
      gaps++;
      if (gaps < 4) console.log('    gap', JSON.stringify(prev.next), '->', JSON.stringify(s.first));
    }
    // The first character of the page and the last before the next page are on screen; the next page's first isn't.
    const v1 = await visible(page, s.first);
    if (v1 !== true) {
      hidden++;
      if (hidden < 4) console.log('    first not visible', JSON.stringify(s.first), v1);
    }
    if (s.next) {
      const vn = await visible(page, s.next);
      if (vn === true && s.next.b !== s.first.b + 0 && false) hidden++;
      if (vn === true) {
        hidden++;
        if (hidden < 4) console.log('    next page start already visible', JSON.stringify(s.next));
      }
    }
    starts.push(s.first);
    prev = s;
  }
  ok(gaps === 0, `${turns} page turns: every page starts where the last ended (${gaps} gaps)`);
  ok(hidden === 0, `each page's first character is on screen and the next page's isn't (${hidden} wrong)`);
  ok(prev.lastPage === true, 'the last page is reported as the last');

  // Opening at the start of a page (the place saved there) shows that page, not the one before.
  let reopened = 0;
  for (const t of starts) {
    await send({ t: 'go', target: { at: t } });
    const s = lastOf(await take(30), 'shown');
    if (s && same(s.first, t)) reopened++;
    else console.log('    reopen', JSON.stringify(t), '->', JSON.stringify(s?.first));
  }
  ok(reopened === starts.length, `opening at each page's start shows that page (${reopened}/${starts.length})`);

  // Jumps land on the page holding the place.
  let jumpsOk = 0;
  const targets = [{ b: 5, i: 40 }, { b: 100, i: 3 }, { b: 161, i: 120 }, { b: 200, i: 0 }, { b: 239, i: 10 }];
  for (const t of targets) {
    await send({ t: 'go', target: { at: t } });
    const s = lastOf(await take(30), 'shown');
    const holds = s && !before(t, s.first) && (!s.next || before(t, s.next));
    if (holds) jumpsOk++;
    else console.log('    jump', JSON.stringify(t), '->', JSON.stringify(s?.first), JSON.stringify(s?.next));
  }
  ok(jumpsOk === targets.length, `jumps land on the page holding the place (${jumpsOk}/${targets.length})`);

  // A bigger text size (the owner's rule): pages are always cut the same way. The page shown is the
  // one holding the place read, as reached by turning in that layout; nothing is split; the line
  // read is marked for a moment, over the text, out of its way.
  const bigger = gen.sanitizeSettings({ hyphenate: true, indent: true, fontSize: 26 });
  await send(setupMsg('page', bigger, screen, { at: { b: 0, i: 0 } }, 'b1'));
  await send({ t: 'content', chunks: [0, 1, 2].map((c) => chunk(c, bigger)), target: { at: { b: 0, i: 0 } }, key: 'b1' });
  const turned = [lastOf(await take(100), 'shown')];
  for (;;) {
    await send({ t: 'turn', dir: 1 });
    const n = lastOf(await take(15), 'shown');
    if (!n) break;
    turned.push(n);
  }
  // Back to the first size, at a place half way down a page; then the bigger size there.
  await send(setupMsg('page', settings, screen, { at: { b: 120, i: 0 } }, 'b2'));
  await send({ t: 'content', chunks: [0, 1, 2].map((c) => chunk(c, settings)), target: { at: { b: 120, i: 0 } }, key: 'b2' });
  await take(100);
  const deep = await page.evaluate((h) => {
    for (const el of document.querySelectorAll('[data-b]')) {
      const n = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
      for (let k = 0; n && k < n.data.length; k += 3) {
        const r = document.createRange();
        r.setStart(n, k);
        r.setEnd(n, k + 1);
        const b = r.getBoundingClientRect();
        if (b.height && b.left >= 0 && b.right <= innerWidth && b.top > h * 0.45 && b.top < h * 0.65) return { b: Number(el.dataset.b), i: k };
      }
    }
    return null;
  }, win.height);
  await send(setupMsg('page', bigger, screen, { at: deep, top: true }, 'b1'));
  const s3 = lastOf(await take(100), 'shown');
  const at3 = turned.findIndex((x) => same(x.first, s3?.first));
  const holds = at3 >= 0 && !before(deep, turned[at3].first) && (!turned[at3].next || before(deep, turned[at3].next));
  const once = await page.evaluate(() => {
    const bs = [...document.querySelectorAll('[data-b]')].map((x) => x.dataset.b);
    return bs.length === new Set(bs).size;
  });
  ok(holds && once && (await visible(page, deep)) === true, `after a text size change, the page shown is the one holding the place read, as reached by turning (page ${at3 + 1} of ${turned.length}: ${JSON.stringify(s3?.first)}), nothing split`);
  // Its line marked: over the line, in the theme's colour, not to be touched.
  const flash = await page.evaluate(() => {
    const m = document.querySelector('#viewport > .flash');
    if (!m) return null;
    const r = m.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, color: getComputedStyle(m).backgroundColor, through: !!hit?.closest('[data-b]') };
  });
  const deepAt = await charAt(page, deep.b, deep.i);
  ok(flash && flash.top <= deepAt.y && flash.bottom >= deepAt.y && flash.left <= deepAt.x && flash.right >= deepAt.x && flash.through && /rgba?\(/.test(flash.color) && flash.color !== 'rgba(0, 0, 0, 0)', `the line read is marked (${flash && `${Math.round(flash.top)}..${Math.round(flash.bottom)} at the place's ${Math.round(deepAt.y)}`}, ${flash?.color}), taps go through it`);
  await page.waitForTimeout(2300);
  ok(!(await page.evaluate(() => document.querySelector('.flash'))), 'the mark fades out by itself');
  await send(setupMsg('page', settings, screen, { at: deep, top: true }, 'b3'));
  await take(100);
  const flashed = await page.evaluate(() => !!document.querySelector('.flash'));
  await send({ t: 'turn', dir: 1 });
  await take(30);
  ok(flashed && !(await page.evaluate(() => document.querySelector('.flash'))), 'a page turned: the mark goes at once');
  const anchor = { b: 120, i: 50 };

  // Selection: the browser's, reported in drawn offsets with carets on screen (text on the page shown).
  await send({ t: 'go', target: { at: anchor } });
  const sNow = lastOf(await take(50), 'shown');
  const selB = sNow.first.b + 1;
  await page.evaluate((selB) => {
    const el = document.querySelector(`[data-b="${selB}"]`);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const n = walker.nextNode();
    const r = document.createRange();
    r.setStart(n, 10);
    r.setEnd(n, 25);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }, selB);
  msgs = await take(250);
  const sel = lastOf(msgs, 'selection');
  ok(sel && same(sel.start, { b: selB, i: 10 }) && same(sel.end, { b: selB, i: 25 }), `selection reported as drawn offsets: ${JSON.stringify(sel?.start)}..${JSON.stringify(sel?.end)}`);
  ok(sel && sel.startCaret.x >= 0 && sel.endCaret.x <= win.width && sel.startCaret.h > 10, `selection ends on screen: ${JSON.stringify(sel?.startCaret)} ${JSON.stringify(sel?.endCaret)}`);
  await send({ t: 'clearSelection' });
  msgs = await take(250);
  ok(msgs.some((m) => m.t === 'noSelection'), 'ending the selection from the screen is reported back');

  // Marks: drawn behind exactly the text asked for.
  await send({ t: 'marks', marks: [{ b: 121, s: 5, e: 30, color: '#ffeb3b88' }, { b: 122, s: 0, e: 12, color: '#81c78488' }] });
  const marked = await page.evaluate(() => {
    if (globalThis.CSS?.highlights) return [...CSS.highlights.values()].flatMap((h) => [...h]).map((r) => r.toString());
    return [...document.querySelectorAll('span[data-mark]')].map((s) => s.textContent);
  });
  const t121 = await page.evaluate(() => document.querySelector('[data-b="121"]').textContent);
  ok(marked.includes(t121.slice(5, 30)), `marks cover exactly their text (${marked.length} ranges)`);

  // The highlight tool out: a tap marks the word, and what's marked is drawn
  // (WebKit doesn't draw highlights over text that can't be selected).
  await send({ t: 'go', target: { at: { b: 121, i: 0 } } });
  await take(30);
  await send({ t: 'tool', marking: true });
  const spot = await charAt(page, 121, 12);
  await page.touchscreen.tap(spot.x, spot.y);
  const tapped = lastOf(await take(100), 'markTap');
  ok(tapped && tapped.at && tapped.at.b === 121, `the highlight tool: a tap reports the word under it: ${JSON.stringify(tapped?.at)}`);
  await send({ t: 'marks', marks: [{ b: 121, s: 5, e: 30, color: '#ffeb3b' }] });
  await take(50);
  const markedPx = await pixel(page, spot.x, spot.y);
  ok(yellowish(markedPx), `marks are drawn while the highlight tool is out (${markedPx})`);
  await send({ t: 'tool', marking: false });
  await take(50);
  const afterPx = await pixel(page, spot.x, spot.y);
  ok(yellowish(afterPx), `and once it's put away (${afterPx})`);
  await send({ t: 'marks', marks: [] });

  // Touches: a tap on the right edge turns, in the middle opens the menu, a swipe turns back.
  await send({ t: 'go', target: { at: { b: 100, i: 0 } } });
  const at = lastOf(await take(30), 'shown');
  const y = win.height / 2;
  await page.touchscreen.tap(win.width - 10, y);
  const afterTap = lastOf(await take(100), 'shown');
  ok(afterTap && afterTap.turned && same(afterTap.first, at.next), 'a tap on the right edge turns the page');
  await page.touchscreen.tap(win.width / 2, y);
  ok((await take(100)).some((m) => m.t === 'tap'), 'a tap in the middle is the menu');
  // A swipe to the right goes back.
  const cdp = ENGINE === 'chromium' ? await page.context().newCDPSession(page) : null;
  if (cdp) {
    const tp = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await tp('touchStart', 60);
    for (let x = 80; x <= 260; x += 30) await tp('touchMove', x);
    await tp('touchEnd', 260);
    const back = lastOf(await take(150), 'shown');
    ok(back && same(back.first, at.first), 'a swipe to the right turns back');
    // The highlight tool: a drag marks from where it started.
    await send({ t: 'tool', marking: true });
    await tp('touchStart', 80);
    for (let x = 110; x <= 230; x += 30) await tp('touchMove', x);
    await tp('touchEnd', 230);
    msgs = await take(150);
    const drag = msgs.filter((m) => m.t === 'markDrag');
    const done = drag.find((m) => m.done);
    ok(done && done.from && done.to && before(done.from, done.to), `the highlight tool reports a drag: ${JSON.stringify(done?.from)} -> ${JSON.stringify(done?.to)}`);
    ok(!msgs.some((m) => m.t === 'shown' && m.turned), 'the highlight tool doesn\'t turn pages while dragging');
    await page.touchscreen.tap(win.width / 2, y);
    ok((await take(100)).some((m) => m.t === 'markTap' && m.at), 'the highlight tool: a tap marks the word');
    await send({ t: 'tool', marking: false });
  }
  await browser.close();
}

// A bundled font, as the app names it in @font-face rules (src/reader/web/webFonts.ts).
const LITERATA = join(ROOT, 'node_modules/@expo-google-fonts/literata');
const face = (file, weight, style) => `@font-face{font-family:'nec-literata';src:url('file://${LITERATA}/${file}');font-weight:${weight};font-style:${style};}`;
const WEB_FONT = {
  css: face('400Regular/Literata_400Regular.ttf', 400, 'normal') + face('400Regular_Italic/Literata_400Regular_Italic.ttf', 400, 'italic') + face('700Bold/Literata_700Bold.ttf', 700, 'normal') + face('700Bold_Italic/Literata_700Bold_Italic.ttf', 700, 'italic'),
  family: "'nec-literata', serif",
  medium: false,
};

// Opening with a font the page hasn't loaded yet (the first book opened after
// the app starts): the place opened is on the page shown once the font is in.
async function webFontTest(screen) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true });
  const f = frameOf('page', settings, screen);
  console.log(`
page mode with a web font not loaded yet (${f.width}×${f.height})`);
  const { browser, page, send, take } = await open({ width: f.width, height: f.height });
  await take(0);
  const at = { b: 150, i: 120 };
  await send(setupMsg('page', settings, screen, { at }, 'f1', WEB_FONT));
  await send({ t: 'bounds', count: 3, complete: true });
  await send({ t: 'content', chunks: [0, 1, 2].map((c) => chunk(c, settings)), target: { at }, key: 'f1' });
  const msgs = await take(800);
  const loaded = await page.evaluate(() => [...document.fonts].filter((x) => x.status === 'loaded').length);
  ok(loaded > 0, `the font loaded (${loaded} faces)`);
  ok((await visible(page, at)) === true, 'the place opened is on screen');
  const s = lastOf(msgs, 'shown');
  ok(s && !before(at, s.first) && (!s.next || before(at, s.next)) && (await visible(page, s.first)) === true, `the page reported holds it: ${JSON.stringify(s?.first)}..${JSON.stringify(s?.next)}`);
  // Another font: the page holding the line read, the line marked.
  await send(setupMsg('page', settings, screen, { at, top: true }, 'f2'));
  const s3 = lastOf(await take(300), 'shown');
  const atNow = await charAt(page, at.b, at.i);
  const mark = await page.evaluate(() => document.querySelector('.flash')?.getBoundingClientRect().toJSON());
  ok(s3 && s3.key === 'f2' && (await visible(page, at)) === true && mark && mark.top <= atNow.y && mark.bottom >= atNow.y, `after a font change, the page shown holds the line read, marked: ${Math.round(atNow.y)} of ${f.height}`);
  await browser.close();
}

// Reading on into a chunk that comes later: the page stays where the reader
// is (not back at the place opened, which the first setup asked for before
// there was any text).
async function laterChunkTest(screen) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true });
  const f = frameOf('page', settings, screen);
  console.log(`\npage mode, reading into a chunk sent later (${f.width}×${f.height})`);
  const { browser, send, take } = await open({ width: f.width, height: f.height });
  await take(0);
  const at = { b: 5, i: 0 };
  await send(setupMsg('page', settings, screen, { at, top: true }, 'l1'));
  await send({ t: 'bounds', count: 3, complete: true });
  await send({ t: 'content', chunks: [0, 1].map((c) => chunk(c, settings)), target: { at, top: true }, key: 'l1' });
  await take(200);
  let need = null;
  let here = null;
  for (let k = 0; k < 400 && !need; k++) {
    await send({ t: 'turn', dir: 1 });
    const msgs = await take(20);
    need = msgs.find((m) => m.t === 'need');
    here = lastOf(msgs, 'shown') ?? here;
  }
  ok(need && need.chunks.includes(2), `at the end of what's there, the next chunk is asked for: ${JSON.stringify(need?.chunks)}`);
  await send({ t: 'add', chunks: [chunk(2, settings)] });
  const after = lastOf(await take(100), 'shown');
  ok(after && here && same(after.first, here.first), `once it's added, still on the same page: ${JSON.stringify(here?.first)} -> ${JSON.stringify(after?.first)}`);
  await send({ t: 'turn', dir: 1 });
  const on = lastOf(await take(30), 'shown');
  ok(on && on.first.b >= 160, `and the next turn goes into it: ${JSON.stringify(on?.first)}`);
  await browser.close();
}

// A picture whose real shape isn't the one given (a photo turned by its EXIF
// data): when it loads, the text after it moves; the page stays on the place.
async function imageTest(screen) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true });
  const f = frameOf('page', settings, screen);
  console.log(`\npage mode, a picture changing size as it loads (${f.width}×${f.height})`);
  const { browser, page, send, take } = await open({ width: f.width, height: f.height });
  await take(0);
  const uri = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 40;
    c.height = 400;
    c.getContext('2d').fillRect(0, 0, 40, 400);
    return c.toDataURL('image/png');
  });
  const blocks = CHUNKS[1].map((blk, k) => (k === 1 ? { k: 'img', s: 'tall.png' } : blk));
  const images = new Map([['tall.png', { uri, width: 400, height: 40 }]]);
  const withImage = { c: 1, html: gen.chunkHtml(blocks, chunkStart(1), settings, 'en', images), chars: chars(blocks) };
  const at = { b: 110, i: 30 };
  await send(setupMsg('page', settings, screen, { at }, 'i1'));
  await send({ t: 'bounds', count: 3, complete: true });
  await send({ t: 'content', chunks: [chunk(0, settings), withImage, chunk(2, settings)], target: { at }, key: 'i1' });
  const msgs = await take(600);
  const tall = await page.evaluate(() => document.querySelector('.img img').getBoundingClientRect().height);
  ok(tall > 100, `the picture took its real shape (${Math.round(tall)} high)`);
  ok((await visible(page, at)) === true, 'the place opened is still on screen');
  const s = lastOf(msgs, 'shown');
  ok(s && !before(at, s.first) && (!s.next || before(at, s.next)), `the page reported holds it: ${JSON.stringify(s?.first)}..${JSON.stringify(s?.next)}`);
  await browser.close();
}

async function scrollImageTest(screen) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true, mode: 'scroll' });
  console.log(`\nscroll mode, a picture above changing size as it loads (${screen.width}×${screen.height})`);
  const { browser, page, send, take } = await open(screen);
  await take(0);
  const uri = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 40;
    c.height = 400;
    c.getContext('2d').fillRect(0, 0, 40, 400);
    return c.toDataURL('image/png');
  });
  const blocks = CHUNKS[1].map((blk, k) => (k === 1 ? { k: 'img', s: 'tall.png' } : blk));
  const images = new Map([['tall.png', { uri, width: 400, height: 40 }]]);
  const withImage = { c: 1, html: gen.chunkHtml(blocks, chunkStart(1), settings, 'en', images), chars: chars(blocks) };
  const at = { b: 110, i: 0 };
  await send(setupMsg('scroll', settings, screen, { at }, 'si1'));
  await send({ t: 'bounds', count: 3, complete: true });
  await send({ t: 'content', chunks: [withImage], target: { at }, key: 'si1' });
  await take(600);
  const tall = await page.evaluate(() => document.querySelector('.img img').getBoundingClientRect().height);
  const top = await page.evaluate(() => document.querySelector('[data-b="110"]').getBoundingClientRect().top);
  ok(tall > 100, `the picture took its real shape (${Math.round(tall)} high)`);
  ok(top > -30 && top < screen.height / 2, `the place opened stays at the top of the screen (${Math.round(top)})`);
  await browser.close();
}

async function scrollTest(screen) {
  const win = screen;
  console.log(`\nscroll mode (${win.width}×${win.height})`);
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true, mode: 'scroll' });
  const { browser, page, send, take } = await open(win);
  await take(0);
  await send(setupMsg('scroll', settings, screen, { at: { b: 83, i: 0 } }, 's1'));
  await send({ t: 'bounds', count: 3, complete: true });
  await send({ t: 'content', chunks: [1].map((c) => chunk(c, settings)), target: { at: { b: 83, i: 0 } }, key: 's1' });
  let msgs = await take(200);
  const s = lastOf(msgs, 'shown');
  ok(s && s.first.b === 83, `opens at the place: ${JSON.stringify(s?.first)}`);
  const need = msgs.filter((m) => m.t === 'need').flatMap((m) => m.chunks);
  ok(need.includes(0), `asks for the chunk before when near its top: ${JSON.stringify(need)}`);
  // The chunk before comes: the text on screen stays put.
  const yBefore = await page.evaluate(() => document.querySelector('[data-b="83"]').getBoundingClientRect().top);
  await send({ t: 'add', chunks: [chunk(0, settings)] });
  await take(50);
  const yAfter = await page.evaluate(() => document.querySelector('[data-b="83"]').getBoundingClientRect().top);
  ok(Math.abs(yBefore - yAfter) < 2, `adding the chunk above keeps the text on screen still (${yBefore.toFixed(1)} -> ${yAfter.toFixed(1)})`);
  // Scroll to the bottom: asks for the next chunk; then the end of the book.
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  msgs = await take(150);
  ok(msgs.some((m) => m.t === 'need' && m.chunks.includes(2)), 'asks for the next chunk near the bottom');
  const topBlock = () => page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-b]')].find((x) => x.getBoundingClientRect().bottom > 60);
    return { b: Number(el.dataset.b), top: el.getBoundingClientRect().top };
  });
  const atBottom = await topBlock();
  await send({ t: 'add', chunks: [chunk(2, settings)] });
  await take(100);
  const afterAdd = await topBlock();
  ok(afterAdd.b === atBottom.b && Math.abs(afterAdd.top - atBottom.top) < 2, `adding the chunk below keeps the text on screen still: ${JSON.stringify(atBottom)} -> ${JSON.stringify(afterAdd)}`);
  await send({ t: 'drop', chunks: [0] });
  await take(100);
  const afterDrop = await topBlock();
  ok(afterDrop.b === atBottom.b && Math.abs(afterDrop.top - atBottom.top) < 2, `dropping the chunk above keeps it still too: ${JSON.stringify(afterDrop)}`);
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  msgs = await take(150);
  ok(msgs.some((m) => m.t === 'reachEnd'), 'the end of the book in view is reported');
  ok(await page.evaluate(() => document.querySelector('.end').textContent === '— The End —'), 'the end of the book says so');
  // Auto-scroll moves, a touch interrupts it.
  await page.evaluate(() => scrollTo(0, 2000));
  await take(50);
  const y0 = await page.evaluate(() => scrollY);
  await send({ t: 'auto', speed: 300 });
  await page.waitForTimeout(500);
  const y1 = await page.evaluate(() => scrollY);
  ok(y1 > y0 + 60, `auto-scroll moves (${y0} -> ${y1})`);
  await page.touchscreen.tap(win.width / 2, win.height / 2);
  ok((await take(100)).some((m) => m.t === 'autoInterrupt'), 'a touch interrupts auto-scroll');
  await send({ t: 'auto', speed: 0 });
  await browser.close();
}

// ---- a longer book: five chunks of the same kind ----
const BOOK = [...CHUNKS, ...[3, 4].map(chunkBlocks)];
/** Chunk `c` of BOOK; `joins`: laid out on from the chunk before (Chunk.joins). */
const bookChunk = (c, settings, joins) => ({ c, html: gen.chunkHtml(BOOK[c], c * 80, settings, 'en', new Map()), chars: chars(BOOK[c]), joins });

// A page turn still sliding when the screen's 'drop' or 'add' for the turn
// before arrives: the turn lands on the next page, not a chunk away (the
// strip used to be renumbered under it, and that wrong place was saved).
async function turnRaceTest(screen) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true });
  const f = frameOf('page', settings, screen);
  console.log(`\npage mode, a chunk added or dropped while a turn slides (${f.width}×${f.height})`);
  for (const turn of ['slide', 'fade']) {
    for (const [label, dir, start, target, during] of [
      ['reading on, the chunk far behind dropped', 1, [0, 1, 2, 3], { chunk: 3, edge: 'first' }, () => ({ t: 'drop', chunks: [0] })],
      ['reading back, the chunk before added', -1, [1, 2, 3], { chunk: 1, edge: 'last' }, () => ({ t: 'add', chunks: [bookChunk(0, settings)] })],
    ]) {
      const { browser, send, take } = await open({ width: f.width, height: f.height });
      await send(setupMsg('page', settings, screen, target, 'k', SYSTEM_FONT, { turn }));
      await send({ t: 'bounds', count: 5, complete: true });
      await send({ t: 'content', chunks: start.map((c) => bookChunk(c, settings)), target, key: 'k' });
      const s0 = lastOf(await take(150), 'shown');
      // Where the turn lands with nothing else going on.
      await send({ t: 'turn', dir });
      const want = [...(await take(400))].reverse().find((m) => m.t === 'shown' && m.turned);
      await send({ t: 'go', target: { at: s0.first } });
      await take(80);
      await send({ t: 'turn', dir });
      await new Promise((r) => setTimeout(r, 40));
      await send(during());
      const got = [...(await take(500))].reverse().find((m) => m.t === 'shown' && m.turned);
      ok(got && want && same(got.first, want.first), `${turn}: ${label} as it slides: lands on the next page ${JSON.stringify(got?.first)} (${JSON.stringify(want?.first)})`);
      await browser.close();
    }
  }
}

// Chunks cut apart only for size, laid out on from each other (Chunk.joins):
// the first one's last page goes on with the second's start instead of being
// left part empty, a paragraph cut between them is one paragraph, and each
// chunk counts the pages that start in it.
const JOINED = (() => {
  // Chunk 1 goes on from chunk 0, in the middle of a paragraph; chunk 3 from chunk 2.
  const words = 'the long road ran on past the mill and over the hill toward the town where nobody waited for the carts'.split(' ');
  const text = (n, k) => Array.from({ length: n }, (_, j) => words[(j * 7 + k) % words.length]).join(' ');
  const c0 = BOOK[0].slice(0, 59).concat([{ k: 'p', r: [`§cut ${text(140, 1)} `] }]);
  const c1 = [{ k: 'p', c: 1, r: [`${text(120, 2)}.`] }, ...BOOK[1].slice(1, 60)];
  return [c0, c1, BOOK[2].slice(0, 60), BOOK[3].slice(0, 60)];
})();
const joinedChunk = (c, settings) => ({ c, html: gen.chunkHtml(JOINED[c], c * 60, settings, 'en', new Map()), chars: chars(JOINED[c]), joins: c % 2 === 1 });

async function joinTest(screen, label) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true });
  const f = frameOf('page', settings, screen);
  console.log(`\npage mode, chunks going on from the one before, ${label} (${f.width}×${f.height}${f.spread ? ', spread' : ''})`);
  const { browser, page, send, take } = await open({ width: f.width, height: f.height });
  await send(setupMsg('page', settings, screen, { at: { b: 0, i: 0 } }, 'j'));
  await send({ t: 'bounds', count: 4, complete: true });
  await send({ t: 'content', chunks: [0, 1, 2, 3].map((c) => joinedChunk(c, settings)), target: { at: { b: 0, i: 0 } }, key: 'j' });
  let msgs = await take(200);
  let s = lastOf(msgs, 'shown');
  const counts = lastOf(msgs, 'pages').counts;
  // Every page in turn: each starts where the last ended, and shows its first character but not the next page's.
  const shown = [s];
  let gaps = 0;
  let hidden = 0;
  for (;;) {
    if ((await visible(page, s.first)) !== true || (s.next && (await visible(page, s.next)) === true)) hidden++;
    await send({ t: 'turn', dir: 1 });
    const n = lastOf(await take(20), 'shown');
    if (!n) break;
    if (!same(s.next, n.first)) gaps++;
    shown.push((s = n));
  }
  const per = f.spread ? 2 : 1;
  ok(gaps === 0 && hidden === 0, `${shown.length} screens: each starts where the last ended, its first character on screen and the next's not (${gaps} gaps, ${hidden} wrong)`);
  // A page belongs to the chunk of its first character: the pages counted are the pages there are (chunks 0-1 and 2-3 each one flow).
  const pagesOf = (c) => counts.find((x) => x.c === c).pages;
  const screens = Math.ceil((pagesOf(0) + pagesOf(1)) / per) + Math.ceil((pagesOf(2) + pagesOf(3)) / per);
  ok(screens === shown.length && counts.every((x) => x.pages > 0), `pages counted per chunk (${counts.map((x) => x.pages).join(', ')}) make the ${shown.length} screens`);
  // The last page of chunk 0 goes on with the start of chunk 1 (and 2's with 3's); chunk 1's pages start after it.
  const shared = shown.findIndex((x) => x.chunk === 0 && x.next && x.next.b >= 60);
  await send({ t: 'go', target: { at: shown[shared].first } });
  await take(30);
  ok(shared >= 0 && (await visible(page, { b: 60, i: 0 })) === true && shown[shared + 1].chunk === 1, `chunk 0's last page goes on with chunk 1's start: ${JSON.stringify(shown[shared]?.first)}..${JSON.stringify(shown[shared]?.next)}`);
  const shared2 = shown.findIndex((x) => x.chunk === 2 && x.next && x.next.b >= 180);
  await send({ t: 'go', target: { at: shown[shared2].first } });
  await take(30);
  ok(shared2 >= 0 && (await visible(page, { b: 180, i: 0 })) === true, `and chunk 2's with chunk 3's`);
  // The paragraph cut between chunks 0 and 1 is one paragraph: its line runs on where they meet.
  const joint = await page.evaluate(() => {
    const box = (b, from) => {
      const el = document.querySelector(`[data-b="${b}"]`);
      const t = el.lastChild?.nodeType === 3 ? el.lastChild : el.firstChild;
      const r = document.createRange();
      const k = from === 'end' ? t.data.trimEnd().length - 1 : 0;
      r.setStart(t, k);
      r.setEnd(t, k + 1);
      return r.getBoundingClientRect();
    };
    const a = box(59, 'end');
    const z = box(60, 'start');
    return { sameLine: Math.abs(a.top - z.top) < 2, wrapper: !!document.querySelector('[data-b="59"]').parentElement.closest('[data-w]') };
  });
  ok(joint.sameLine && joint.wrapper, `a paragraph cut between the two chunks is one paragraph: ${JSON.stringify(joint)}`);
  // Going to a page by its number in chunk 1: the first page that starts in it (in a spread, maybe the right-hand page of the one it shares).
  await send({ t: 'go', target: { chunk: 1, page: 0 } });
  msgs = await take(30);
  const p1 = lastOf(msgs, 'shown');
  const where = lastOf(msgs, 'pages');
  const p1At = shown.findIndex((x) => same(x.first, p1?.first));
  ok(p1 && (same(p1.first, shown[shared + 1].first) ? where.chunk === 1 && where.page === 0 : f.spread && p1At === shared && where.span === 2), `chunk 1's first page is the one after the page it shares: ${JSON.stringify(p1?.first)} (${where?.chunk}:${where?.page})`);
  // Read on to chunk 3: the screen drops chunk 0. Chunk 1's pages stay as they were.
  await send({ t: 'go', target: { chunk: 1, page: 3 } });
  const p13 = lastOf(await take(30), 'shown');
  await send({ t: 'go', target: { chunk: 3, edge: 'last' } });
  await take(30);
  await send({ t: 'drop', chunks: [0] });
  await take(50);
  await send({ t: 'go', target: { chunk: 1, page: 3 } });
  msgs = await take(50);
  const after = lastOf(msgs, 'pages');
  ok(same(lastOf(msgs, 'shown')?.first, p13.first) && after?.counts.find((x) => x.c === 1)?.pages === pagesOf(1) && !after.counts.some((x) => x.c === 0), `with chunk 0 dropped, chunk 1's pages stay where they were (${after?.counts.map((x) => `${x.c}:${x.pages}`).join(' ')})`);
  // Back onto the page chunk 0 shares with it: chunk 0 is asked for again first.
  let here = lastOf(msgs, 'shown');
  let asked = false;
  for (let k = 0; k < 6 && !asked; k++) {
    await send({ t: 'turn', dir: -1 });
    msgs = await take(250);
    asked = msgs.some((m) => m.t === 'need' && m.chunks.includes(0)) && !msgs.some((m) => m.t === 'shown');
    here = lastOf(msgs, 'shown') ?? here;
  }
  ok(asked && here.chunk === 1, `turning back onto chunk 0's page asks for it first (from ${JSON.stringify(here.first)})`);
  await send({ t: 'add', chunks: [joinedChunk(0, settings)] });
  await take(30);
  await send({ t: 'turn', dir: -1 });
  const back = lastOf(await take(30), 'shown');
  const before0 = shown[shown.findIndex((x) => same(x.first, here.first)) - 1];
  ok(back && same(back.first, before0.first), `once it's back, that page is as it was: ${JSON.stringify(back?.first)}`);
  await browser.close();

  // Opened with chunk 1 but not chunk 0 (a jump): chunk 1 can't be laid out as it will be yet, so it isn't shown; chunk 0 is asked for.
  const b2 = await open({ width: f.width, height: f.height });
  await b2.send(setupMsg('page', settings, screen, { at: { b: 120, i: 0 } }, 'j'));
  await b2.send({ t: 'bounds', count: 4, complete: true });
  await b2.send({ t: 'content', chunks: [1, 2, 3].map((c) => joinedChunk(c, settings)), target: { chunk: 2, edge: 'first' }, key: 'j' });
  msgs = await b2.take(200);
  const needs0 = msgs.some((m) => m.t === 'need' && m.chunks.includes(0));
  const counted = lastOf(msgs, 'pages')?.counts.map((x) => x.c);
  await b2.send({ t: 'turn', dir: -1 });
  const blocked = !(await b2.take(250)).some((m) => m.t === 'shown');
  ok(needs0 && blocked && !counted?.includes(1), `opened without chunk 0: chunk 1 isn't shown or counted, chunk 0 is asked for (${JSON.stringify(counted)})`);
  await b2.send({ t: 'add', chunks: [joinedChunk(0, settings)] });
  await b2.take(30);
  await b2.send({ t: 'turn', dir: -1 });
  const last1 = lastOf(await b2.take(30), 'shown');
  ok(last1 && same(last1.first, shown[shown.findIndex((x) => x.chunk === 2) - 1].first), `once it comes, chunk 1's last page is the one read from the start: ${JSON.stringify(last1?.first)}`);
  await b2.browser.close();
}

// Auto-scroll: it keeps its place when a chunk above is dropped (it used to
// jump a chunk ahead each time reading entered a new one), and it moves a
// little every frame at reading speed (a page scrolls by whole points only).
async function autoScrollTest(screen) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true, mode: 'scroll' });
  console.log(`\nscroll mode, auto-scroll (${screen.width}×${screen.height})`);
  const { browser, page, send, take } = await open(screen);
  await send(setupMsg('scroll', settings, screen, { at: { b: 250, i: 0 } }, 'a'));
  await send({ t: 'bounds', count: 5, complete: true });
  await send({ t: 'content', chunks: [0, 1, 2, 3].map((c) => bookChunk(c, settings)), target: { at: { b: 250, i: 0 } }, key: 'a' });
  await take(200);
  const topBlock = () => page.evaluate(() => Number([...document.querySelectorAll('[data-b]')].find((x) => x.getBoundingClientRect().bottom > 60).dataset.b));
  await send({ t: 'auto', speed: 60 });
  await take(300);
  const a = await topBlock();
  await send({ t: 'drop', chunks: [0] });
  await take(300);
  const z = await topBlock();
  ok(z - a <= 2, `the chunk above dropped while it scrolls: it goes on from the same place (block ${a} -> ${z} in 0.3 s at 60 pt/s)`);
  await send({ t: 'auto', speed: 0 });
  await take(50);
  // At 12 points a second (a fifth of a point a frame), the text moves on (nearly) every frame.
  await send({ t: 'auto', speed: 12 });
  const ys = await page.evaluate(() => new Promise((res) => {
    const el = document.querySelector('[data-b="250"]');
    const ys = [];
    const f = () => {
      ys.push(el.getBoundingClientRect().top);
      if (ys.length < 90) requestAnimationFrame(f);
      else res(ys);
    };
    requestAnimationFrame(f);
  }));
  await send({ t: 'auto', speed: 0 });
  const still = ys.slice(1).filter((y, k) => Math.abs(y - ys[k]) < 0.01).length;
  ok(still < ys.length * 0.25 && ys[ys.length - 1] < ys[0], `at 12 pt/s the text moves smoothly: ${still} of ${ys.length - 1} frames stood still (${(ys[0] - ys[ys.length - 1]).toFixed(1)} pt in all)`);
  await browser.close();
}

// A picture taller than the page keeps its shape (it used to be squashed to fit).
async function pictureTest(screen) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true });
  const f = frameOf('page', settings, screen);
  console.log(`\npage mode, pictures of every shape (${f.width}×${f.height}${f.spread ? ', spread' : ''})`);
  const { browser, page, send, take } = await open({ width: f.width, height: f.height });
  const sizes = [[1400, 2100], [600, 2000], [2400, 600], [120, 90]];
  const uris = await page.evaluate((sizes) => sizes.map(([w, h]) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').fillRect(0, 0, w, h);
    return c.toDataURL('image/png');
  }), sizes);
  const blocks = CHUNKS[0].slice(0, 30);
  const images = new Map();
  sizes.forEach(([w, h], k) => {
    images.set(`i${k}`, { uri: uris[k], width: w, height: h });
    blocks.splice(3 + k * 6, 0, { k: 'img', s: `i${k}` });
  });
  await send(setupMsg('page', settings, screen, { at: { b: 0, i: 0 } }, 'p'));
  await send({ t: 'bounds', count: 1, complete: true });
  await send({ t: 'content', chunks: [{ c: 0, html: gen.chunkHtml(blocks, 0, settings, 'en', images), chars: 1000 }], target: { at: { b: 0, i: 0 } }, key: 'p' });
  await take(500);
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.img img')].map((im) => {
    const r = im.getBoundingClientRect();
    return { w: r.width, h: r.height, nw: im.naturalWidth, nh: im.naturalHeight };
  }));
  const bad = boxes.filter((b) => Math.abs(b.w / b.h / (b.nw / b.nh) - 1) > 0.02 || b.w > f.column + 0.5 || b.h > f.height + 0.5);
  ok(boxes.length === 4 && !bad.length, `each picture keeps its shape, inside the column and the page: ${boxes.map((b) => `${b.nw}×${b.nh} -> ${Math.round(b.w)}×${Math.round(b.h)}`).join(', ')}`);
  await browser.close();
}

// A paragraph stored in several blocks (over 3,000 characters) is drawn as
// one: no line ends short where its blocks meet. And a page made to start
// inside it (a text size change) still starts at the word read.
async function longParagraphTest(screen) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true });
  const f = frameOf('page', settings, screen);
  console.log(`\npage mode, a long paragraph stored in parts (${f.width}×${f.height})`);
  const piece = (k) => ({ k: 'p', ...(k ? { c: 1 } : {}), r: [Array.from({ length: 330 }, (_, j) => words[(j * 5 + k * 3) % words.length]).join(' ') + (k < 3 ? ' ' : '.')] });
  const blocks = [{ k: 'h', l: 2, r: ['A long one'] }, piece(0), piece(1), piece(2), piece(3), { k: 'p', r: ['After it.'] }];
  const html = gen.chunkHtml(blocks, 0, settings, 'en', new Map());
  const { browser, page, send, take } = await open({ width: f.width, height: f.height });
  await send(setupMsg('page', settings, screen, { at: { b: 0, i: 0 } }, 'l'));
  await send({ t: 'bounds', count: 1, complete: true });
  await send({ t: 'content', chunks: [{ c: 0, html, chars: 9000 }], target: { at: { b: 0, i: 0 } }, key: 'l' });
  await take(150);
  // Where each part meets the next, the next part's first word goes on along the same line (or the line was full).
  const joints = await page.evaluate(() => [1, 2, 3].map((b) => {
    const box = (el, k) => {
      const t = el.firstChild;
      const r = document.createRange();
      r.setStart(t, k);
      r.setEnd(t, k + 1);
      return r.getBoundingClientRect();
    };
    const a = document.querySelector(`[data-b="${b}"]`);
    const z = document.querySelector(`[data-b="${b + 1}"]`);
    const end = box(a, a.firstChild.data.trimEnd().length - 1);
    const piece = [...a.parentElement.getClientRects()].find((q) => q.left <= end.left && q.right >= end.right);
    return Math.abs(end.top - box(z, 0).top) < 2 ? 'on' : piece && piece.right - end.right < 1.5 ? 'full line' : 'short line';
  }));
  ok(joints.every((x) => x !== 'short line'), `where its parts meet, the line runs on: ${JSON.stringify(joints)}`);
  // A text size change with the place read half way down a page, inside the third part: the page
  // holding it is shown, the paragraph still one, its line marked.
  const bigger = gen.sanitizeSettings({ hyphenate: true, indent: true, fontSize: 25 });
  await send(setupMsg('page', bigger, screen, { at: { b: 3, i: 0 } }, 'l2'));
  await send({ t: 'content', chunks: [{ c: 0, html: gen.chunkHtml(blocks, 0, bigger, 'en', new Map()), chars: 9000 }], target: { at: { b: 3, i: 0 } }, key: 'l2' });
  await take(100);
  const at = await page.evaluate((h) => {
    const t = document.querySelector('[data-b="3"]').firstChild;
    for (let k = 0; k < t.data.length; k += 3) {
      const r = document.createRange();
      r.setStart(t, k);
      r.setEnd(t, k + 1);
      const q = r.getBoundingClientRect();
      if (q.height && q.left >= 0 && q.right <= innerWidth && q.top > h * 0.45 && q.top < h * 0.65) return { b: 3, i: k };
    }
    return null;
  }, f.height);
  const before3 = lastOf(await (async () => {
    await send({ t: 'go', target: { at } });
    return take(30);
  })(), 'shown');
  await send(setupMsg('page', bigger, screen, { at, top: true }, 'l3'));
  const s = lastOf(await take(100), 'shown');
  const wrappers = await page.evaluate(() => [document.querySelectorAll('[data-w]').length, document.querySelectorAll('[data-b="3"]').length]);
  const mark = await page.evaluate(() => document.querySelector('.flash')?.getBoundingClientRect().toJSON());
  const atNow = await charAt(page, 3, at.i);
  ok(at && s && same(s.first, before3.first) && wrappers.join() === '1,1' && mark && mark.top <= atNow.y && mark.bottom >= atNow.y, `after a text size change, the page holding the place inside it is shown (${JSON.stringify(s?.first)}), the paragraph still one, the line marked`);
  await browser.close();
}

// No lone line of a paragraph at a page's foot or top, no heading at a
// page's foot (WebKit ignores break-after: avoid): over many pages.
async function loneLinesTest(screen) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true });
  const f = frameOf('page', settings, screen);
  console.log(`\npage mode, lone lines and headings at the foot of pages (${f.width}×${f.height}${f.spread ? ', spread' : ''})`);
  const { browser, page, send, take } = await open({ width: f.width, height: f.height });
  await send(setupMsg('page', settings, screen, { at: { b: 0, i: 0 } }, 'h'));
  await send({ t: 'bounds', count: 1, complete: true });
  let total = { stranded: 0, headings: 0, lone: 0, split: 0, gaps: 0 };
  for (let v = 0; v < 24; v++) {
    const blocks = [];
    for (let k = 0; k < 40; k++) {
      const n = 10 + ((k * 7 + v * 3) % 40);
      blocks.push({ k: 'p', r: [Array.from({ length: n }, (_, j) => words[(j * 3 + k + v) % words.length]).join(' ') + '.'] });
      if (k % 4 === 3) blocks.push({ k: 'h', l: 2 + (k % 3), r: [`Section ${k}`] });
    }
    await send({ t: 'content', chunks: [{ c: 0, html: gen.chunkHtml(blocks, 0, settings, 'en', new Map()), chars: 1 }], target: { at: { b: 0, i: 0 } }, key: 'h' });
    await take(10);
    const r = await page.evaluate(({ pitch, gap, padLeft }) => {
      const sec = document.querySelector('#strip > .chunk');
      const origin = sec.getBoundingClientRect().left + padLeft;
      const col = (x) => Math.floor((x - origin + gap / 2) / pitch);
      const out = { stranded: 0, headings: 0, lone: 0, split: 0 };
      const els = [...sec.children];
      els.forEach((el, k) => {
        if (/^h\d$/.test(el.classList[0])) {
          out.headings++;
          const last = Math.max(...[...el.getClientRects()].map((q) => col(q.left)));
          if (els[k + 1] && col(els[k + 1].getClientRects()[0].left) !== last) out.stranded++;
          return;
        }
        const lines = new Map();
        const t = el.firstChild;
        for (let i = 0; i < t.data.length; i++) {
          const r = document.createRange();
          r.setStart(t, i);
          r.setEnd(t, i + 1);
          const q = [...r.getClientRects()].find((x) => x.width > 0);
          if (!q) continue;
          const c = col(q.left);
          if (!lines.has(c)) lines.set(c, new Set());
          lines.get(c).add(Math.round(q.bottom));
        }
        const per = [...lines.keys()].sort((a, b) => a - b).map((c) => lines.get(c).size);
        if (per.length > 1) {
          out.split++;
          if (per[0] === 1 || per[per.length - 1] === 1) out.lone++;
        }
      });
      return out;
    }, { pitch: f.column + f.gap, gap: f.gap, padLeft: f.left - (f.inset?.left ?? 0) });
    for (const k of Object.keys(r)) total[k] += r[k];
  }
  ok(total.stranded === 0, `no heading at the foot of a page: ${total.stranded} of ${total.headings}`);
  ok(total.lone === 0 && total.split > 20, `no paragraph leaves a lone line at a page's foot or top: ${total.lone} of ${total.split} split between pages`);
  await browser.close();
}

// The book's language on the page: <html lang>, and in Turkish no "fi"
// ligature, which would hide the dot of the i (PT Serif draws one even with
// lang="tr"; other fonts drop it for Turkish themselves).
const PT_SERIF = join(ROOT, 'node_modules/@expo-google-fonts/pt-serif/400Regular/PTSerif_400Regular.ttf');
async function languageTest(screen) {
  const settings = gen.sanitizeSettings({});
  const f = frameOf('page', settings, screen);
  console.log(`\nthe book's language (${f.width}×${f.height})`);
  const { browser, page, send, take } = await open({ width: f.width, height: f.height });
  const font = { css: `@font-face{font-family:'nec-ptserif';src:url('file://${PT_SERIF}');font-weight:400;font-style:normal;}`, family: "'nec-ptserif', serif", medium: false };
  const blocks = [{ k: 'p', r: ['fi fi fi'] }];
  const shot = async (lang) => {
    await send(setupMsg('page', settings, screen, { at: { b: 0, i: 0 } }, `t${lang}`, font, { lang }));
    await send({ t: 'content', chunks: [{ c: 0, html: gen.chunkHtml(blocks, 0, settings, lang, new Map()), chars: 8 }], target: { at: { b: 0, i: 0 } }, key: `t${lang}` });
    await take(300);
    const el = page.locator('[data-b="0"]');
    const normal = await el.screenshot();
    await page.evaluate(() => (document.querySelector('[data-b="0"]').style.fontVariantLigatures = 'none'));
    const none = await el.screenshot();
    return { lang: await page.evaluate(() => document.documentElement.lang), ligature: !normal.equals(none) };
  };
  await send({ t: 'bounds', count: 1, complete: true });
  const en = await shot('en');
  const tr = await shot('tr');
  ok(en.lang === 'en' && tr.lang === 'tr', `the page says the book's language: ${en.lang}, ${tr.lang}`);
  ok(en.ligature && !tr.ligature, `"fi" drawn as one letter in English (${en.ligature}) but not in Turkish (${tr.ligature})`);
  await browser.close();
}

// Settings changed (the theme, the text size): the font's files aren't
// loaded again, and only the faces the text uses are loaded at all.
async function fontLoadTest(screen) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true });
  const f = frameOf('page', settings, screen);
  console.log(`\npage mode, a web font and settings changes (${f.width}×${f.height})`);
  const variants = [['400Regular/Literata_400Regular.ttf', 400, 'normal'], ['400Regular_Italic/Literata_400Regular_Italic.ttf', 400, 'italic'], ['700Bold/Literata_700Bold.ttf', 700, 'normal'], ['700Bold_Italic/Literata_700Bold_Italic.ttf', 700, 'italic'], ['500Medium/Literata_500Medium.ttf', 500, 'normal'], ['500Medium_Italic/Literata_500Medium_Italic.ttf', 500, 'italic']];
  const faces = variants.map(([file, weight, style]) => ({ weight, css: face(file, weight, style) }));
  const font = { css: faces.map((x) => x.css).join(''), faces, family: "'nec-literata', serif", medium: true };
  const { browser, page, send, take } = await open({ width: f.width, height: f.height });
  const loads = [];
  page.on('request', (r) => r.url().endsWith('.ttf') && loads.push(r.url().split('/').pop()));
  await send(setupMsg('page', settings, screen, { at: { b: 0, i: 0 } }, 'f0', font));
  await send({ t: 'bounds', count: 3, complete: true });
  await send({ t: 'content', chunks: [0, 1, 2].map((c) => chunk(c, settings)), target: { at: { b: 0, i: 0 } }, key: 'f0' });
  await take(600);
  const first = loads.length;
  ok(first === 4 && !loads.some((x) => x.includes('Medium')), `only the faces the text uses are loaded: ${loads.join(', ')}`);
  for (let k = 0; k < 4; k++) {
    const s = gen.sanitizeSettings({ hyphenate: true, indent: true, fontSize: 19 + k });
    await send(setupMsg('page', s, screen, { at: { b: 100, i: 0 }, top: true }, `f${k + 1}`, font, { theme: k % 2 ? gen.THEMES.sepia : gen.THEMES.light }));
    await take(150);
  }
  ok(loads.length === first, `four changes of theme and text size load no font file again (${loads.length - first} loaded)`);
  await browser.close();
}

// A footnote mark is small: a tap near it opens the note too.
async function footnoteTest(screen) {
  const settings = gen.sanitizeSettings({});
  const f = frameOf('page', settings, screen);
  console.log(`\npage mode, tapping a footnote mark (${f.width}×${f.height})`);
  const { browser, page, send, take } = await open({ width: f.width, height: f.height });
  const blocks = [...CHUNKS[0].slice(1, 4), { k: 'p', r: ['A sentence with a note', ['1', 8 | 32, 'n1'], ' and more text after it, then another', ['23', 8 | 32, 'n23'], ' here.'] }];
  await send(setupMsg('page', settings, screen, { at: { b: 0, i: 0 } }, 'n'));
  await send({ t: 'bounds', count: 1, complete: true });
  await send({ t: 'content', chunks: [{ c: 0, html: gen.chunkHtml(blocks, 0, settings, 'en', new Map()), chars: 1 }], target: { at: { b: 0, i: 0 } }, key: 'n' });
  await take(150);
  const box = await page.evaluate(() => {
    const r = document.querySelector('[data-link="n1"]').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  });
  let hits = 0;
  const near = [[0, 0], [box.w / 2 + 4, 0], [-(box.w / 2 + 4), 0], [0, box.h / 2 + 4], [0, -(box.h / 2 + 4)], [box.w / 2 + 7, 2]];
  for (const [dx, dy] of near) {
    await page.touchscreen.tap(box.x + dx, box.y + dy);
    if ((await take(120)).some((m) => m.t === 'link' && m.target === 'n1')) hits++;
  }
  ok(hits === near.length, `taps on and around the mark (${box.w.toFixed(1)}×${box.h.toFixed(1)} pt) open the note: ${hits} of ${near.length}`);
  await page.touchscreen.tap(box.x + 60, box.y);
  ok(!(await take(120)).some((m) => m.t === 'link'), 'a tap well away from it does not');
  await browser.close();
}

// The book's own styles: small capitals, centred and right-aligned text.
async function bookStylesTest(screen) {
  const settings = gen.sanitizeSettings({ indent: true });
  const f = frameOf('page', settings, screen);
  console.log(`\nthe book's own styles (${f.width}×${f.height})`);
  const { browser, page, send, take } = await open({ width: f.width, height: f.height });
  const blocks = [{ k: 'p', a: 'c', r: ['* * *'] }, { k: 'p', a: 'r', r: ['— ', ['Signed', 64]] }, { k: 'h', l: 2, a: 'r', r: ['Right'] }];
  await send(setupMsg('page', settings, screen, { at: { b: 0, i: 0 } }, 's'));
  await send({ t: 'bounds', count: 1, complete: true });
  await send({ t: 'content', chunks: [{ c: 0, html: gen.chunkHtml(blocks, 0, settings, 'en', new Map()), chars: 1 }], target: { at: { b: 0, i: 0 } }, key: 's' });
  await take(100);
  const got = await page.evaluate(() => ({
    align: [0, 1, 2].map((b) => getComputedStyle(document.querySelector(`[data-b="${b}"]`)).textAlign),
    caps: [...document.querySelectorAll('[data-b="1"] span')].map((x) => getComputedStyle(x).fontVariantCaps).join(),
    texts: [0, 1].map((b) => document.querySelector(`[data-b="${b}"]`).textContent),
  }));
  ok(JSON.stringify(got.align) === '["center","right","right"]' && got.caps === 'small-caps', `centred, right-aligned and small capitals: ${JSON.stringify(got)}`);
  ok(got.texts[0] === gen.drawn(blocks[0], gen.lookOf(blocks[0], settings, 'en')).text && !got.texts[0].startsWith(' '), 'centred text has no indent, on the page as in look.ts');
  await browser.close();
}

// A selection reaching between two blocks (a paragraph selected to its edge)
// is reported, with its ends at those blocks' edges. And a NUL in a block
// takes one character on the page, so offsets after it hold.
async function selectionEdgesTest(screen) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true });
  const f = frameOf('page', settings, screen);
  console.log(`\npage mode, selections to a block's edge (${f.width}×${f.height})`);
  const { browser, page, send, take } = await open({ width: f.width, height: f.height });
  const blocks = CHUNKS[0].slice(0, 20).map((b, k) => (k === 9 ? { k: 'p', r: ['A NUL\u0000 in it, then words to select after it.'] } : b));
  await send(setupMsg('page', settings, screen, { at: { b: 0, i: 0 } }, 'e'));
  await send({ t: 'bounds', count: 1, complete: true });
  await send({ t: 'content', chunks: [{ c: 0, html: gen.chunkHtml(blocks, 0, settings, 'en', new Map()), chars: 1 }], target: { at: { b: 5, i: 0 } }, key: 'e' });
  await take(100);
  const select = async (fn, arg) => {
    await page.evaluate(fn, arg);
    return lastOf(await take(300), 'selection');
  };
  const end = await select(() => {
    const el = document.querySelector('[data-b="6"]');
    const r = document.createRange();
    r.setStart(el.firstChild, 3);
    r.setEnd(el.parentNode, [...el.parentNode.childNodes].indexOf(el) + 1);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  const len6 = await page.evaluate(() => document.querySelector('[data-b="6"]').textContent.length);
  ok(end && same(end.start, { b: 6, i: 3 }) && same(end.end, { b: 6, i: len6 }), `ending after a paragraph: ${JSON.stringify([end?.start, end?.end])}`);
  const start = await select(() => {
    const el = document.querySelector('[data-b="7"]');
    const r = document.createRange();
    r.setStart(el.parentNode, [...el.parentNode.childNodes].indexOf(el));
    r.setEnd(el.firstChild, 12);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  ok(start && same(start.start, { b: 7, i: 0 }) && same(start.end, { b: 7, i: 12 }), `starting before a paragraph: ${JSON.stringify([start?.start, start?.end])}`);
  const drawn9 = gen.drawn(blocks[9], gen.lookOf(blocks[9], settings, 'en')).text;
  const k = drawn9.indexOf('words');
  const nul = await select((k) => {
    const t = document.querySelector('[data-b="9"]').firstChild;
    const r = document.createRange();
    r.setStart(t, k);
    r.setEnd(t, k + 5);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    return t.data.length;
  }, k);
  ok(nul && same(nul.start, { b: 9, i: k }) && (await page.evaluate(() => document.querySelector('[data-b="9"]').textContent.length)) === drawn9.length, `after a NUL, a selection is where it is in the book: ${JSON.stringify(nul?.start)} (${k})`);
  await send({ t: 'clearSelection' });
  await browser.close();
}

// Touches (Chromium's touch events): a long press then a drag is selecting,
// not turning; two fingers (a pinch, a resting thumb) neither turn nor tap.
async function touchTest(screen) {
  if (ENGINE !== 'chromium') return;
  const settings = gen.sanitizeSettings({});
  const f = frameOf('page', settings, screen);
  console.log(`\npage mode, touches that aren't page turns (${f.width}×${f.height})`);
  const { browser, page, send, take } = await open({ width: f.width, height: f.height });
  await send(setupMsg('page', settings, screen, { at: { b: 100, i: 0 } }, 't', SYSTEM_FONT, { turn: 'slide' }));
  await send({ t: 'bounds', count: 3, complete: true });
  await send({ t: 'content', chunks: [0, 1, 2].map((c) => chunk(c, settings)), target: { at: { b: 100, i: 0 } }, key: 't' });
  await take(200);
  const cdp = await page.context().newCDPSession(page);
  const tp = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const y = 300;
  await tp('touchStart', [{ x: 200, y }]);
  await page.waitForTimeout(600);
  for (let x = 190; x >= 60; x -= 15) {
    await tp('touchMove', [{ x, y }]);
    await page.waitForTimeout(16);
  }
  await tp('touchEnd', []);
  let msgs = await take(400);
  ok(!msgs.some((m) => m.t === 'shown' && m.turned), 'a long press, then a drag sideways (selecting): the page stays');
  await tp('touchStart', [{ x: 150, y: 300, id: 1 }]);
  await tp('touchStart', [{ x: 150, y: 300, id: 1 }, { x: 250, y: 500, id: 2 }]);
  for (let k = 1; k <= 6; k++) {
    await tp('touchMove', [{ x: 150 - k * 12, y: 300 - k * 10, id: 1 }, { x: 250 + k * 12, y: 500 + k * 10, id: 2 }]);
    await page.waitForTimeout(16);
  }
  await tp('touchEnd', [{ x: 322, y: 560, id: 2 }]);
  await tp('touchEnd', []);
  msgs = await take(400);
  ok(!msgs.some((m) => (m.t === 'shown' && m.turned) || m.t === 'tap'), 'two fingers: no turn, no menu');
  await tp('touchStart', [{ x: f.width - 12, y }]);
  await tp('touchEnd', []);
  ok((await take(400)).some((m) => m.t === 'shown' && m.turned), 'and a tap on the edge after them still turns');
  await browser.close();
}

// Scroll mode: the place reported is the text at the top of the screen, also
// when the top falls between two paragraphs (Chromium gave the one above).
async function scrollPlaceTest(screen) {
  // Quotes and verse, indented, for the top to fall beside.
  const settings = gen.sanitizeSettings({ mode: 'scroll' });
  const f = frameOf('scroll', settings, screen);
  console.log(`\nscroll mode, the place at the top (${screen.width}×${screen.height})`);
  const { browser, page, send, take } = await open(screen);
  const indented = (c) => {
    const blocks = CHUNKS[c].map((b, k) => (k % 5 === 2 && b.r ? { k: 'q', r: b.r } : k % 5 === 4 ? { k: 'v', r: ['a line of verse\nanother line of the verse'] } : b));
    return { c, html: gen.chunkHtml(blocks, chunkStart(c), settings, 'en', new Map()), chars: chars(blocks) };
  };
  await send(setupMsg('scroll', settings, screen, { at: { b: 80, i: 0 } }, 's'));
  await send({ t: 'bounds', count: 3, complete: true });
  await send({ t: 'content', chunks: [0, 1, 2].map(indented), target: { at: { b: 80, i: 0 } }, key: 's' });
  await take(200);
  let wrong = 0;
  let n = 0;
  for (let k = 0; k < 40; k++) {
    await page.evaluate((y) => scrollTo(0, y), 3000 + k * 1733);
    const s = lastOf(await take(120), 'shown');
    if (!s) continue;
    n++;
    // The reported character's line crosses the top of the text area, or is the first below it.
    const at = await charAt(page, s.first.b, s.first.i);
    const lh = settings.fontSize * settings.lineSpacing;
    if (!at || at.y < f.top - lh / 2 || at.y > f.top + lh * 1.5) {
      wrong++;
      if (wrong < 4) console.log('    reported', JSON.stringify(s.first), 'drawn at y', at && Math.round(at.y), 'top', f.top);
    }
  }
  ok(n > 20 && wrong === 0, `${n} places: the one reported is the text at the top (${wrong} wrong)`);
  await browser.close();
}

// A spread: 'pages' says how many pages show (the footer says "40–41"), and
// nothing of the next screen shows at the edge, even in a WebView wider than
// the window it was laid out for (Android in landscape, the camera on the right).
async function spreadTest() {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true });
  console.log('\npage mode, a spread');
  const window = { width: 862, height: 411 };
  const insets = { top: 0, bottom: 16, left: 0, right: 52 };
  const frame = gen.webFrame(window, insets, settings.margin, 'page');
  const { browser, page, send, take } = await open({ width: 914, height: frame.height });
  await send(setupMsg('page', settings, window, { at: { b: 0, i: 0 } }, 'w', SYSTEM_FONT, { frame }));
  await send({ t: 'bounds', count: 3, complete: true });
  await send({ t: 'content', chunks: [0, 1, 2].map((c) => chunk(c, settings)), target: { at: { b: 0, i: 0 } }, key: 'w' });
  let msgs = await take(200);
  // Each screen: does its right-hand page have text, and what does 'pages' say?
  const rightHasText = () => page.evaluate(() => {
    const vp = document.getElementById('viewport').getBoundingClientRect();
    const mid = vp.left + vp.width / 2;
    for (const el of document.querySelectorAll('[data-b]')) for (const q of el.getClientRects()) if (q.width > 0 && q.left >= mid && q.right <= vp.right) return true;
    return false;
  });
  const spans = [];
  let wrongSpan = 0;
  for (let p = lastOf(msgs, 'pages'); p; p = lastOf(await take(20), 'pages')) {
    spans.push(p.span);
    if ((p.span === 2) !== (await rightHasText())) wrongSpan++;
    await send({ t: 'turn', dir: 1 });
  }
  // A chunk of one page: its screen shows one.
  await send({ t: 'content', chunks: [{ c: 0, html: gen.chunkHtml(CHUNKS[0].slice(0, 2), 0, settings, 'en', new Map()), chars: 1 }], target: { at: { b: 0, i: 0 } }, key: 'w' });
  spans.push(lastOf(await take(100), 'pages').span);
  // What's drawn is what's inside #viewport: the next screen's first page lies just past it.
  const clip = await page.evaluate(() => document.getElementById('viewport').getBoundingClientRect().right);
  ok(clip <= 862 - 52 + 0.5, `pages are drawn only between the insets of the window laid out for: up to ${clip} pt of the 914`);
  ok(wrongSpan === 0 && spans.includes(1) && spans.includes(2), `${spans.length} screens: 'pages' says two when the right-hand page has text, else one (${wrongSpan} wrong: ${spans.join('')})`);
  ok(frame.gap === 2 * settings.margin, `the middle of the spread is just the two margins (${frame.gap} pt)`);
  await browser.close();
}

// Wide screens: about 70 characters a line, two pages side by side where they still hold 50.
async function measureTest() {
  console.log('\nline length on wide screens');
  const rows = [];
  for (const [label, win, mode] of [['tablet upright', { width: 820, height: 1180 }, 'page'], ['tablet upright, scroll', { width: 820, height: 1180 }, 'scroll'], ['phone landscape, scroll', { width: 852, height: 393 }, 'scroll']]) {
    const settings = gen.sanitizeSettings({ mode });
    const insets = win.width > win.height ? { top: 0, bottom: 21, left: 59, right: 59 } : { top: 24, bottom: 20, left: 0, right: 0 };
    const frame = gen.webFrame(win, insets, settings.margin, mode, settings);
    const { browser, page, send, take } = await open(mode === 'page' ? { width: frame.width, height: frame.height } : win);
    await send(setupMsg(mode, settings, win, { at: { b: 0, i: 0 } }, 'm', SYSTEM_FONT, { frame }));
    await send({ t: 'bounds', count: 1, complete: true });
    await send({ t: 'content', chunks: [chunk(0, settings)], target: { at: { b: 0, i: 0 } }, key: 'm' });
    await take(150);
    const perLine = await page.evaluate(() => {
      const counts = [];
      for (const p of [...document.querySelectorAll('p.p')].slice(0, 30)) {
        const t = p.firstChild;
        const lines = new Map();
        for (let i = 0; i < t.data.length; i++) {
          if (t.data[i] === '­') continue;
          const r = document.createRange();
          r.setStart(t, i);
          r.setEnd(t, i + 1);
          const q = [...r.getClientRects()].find((x) => x.width > 0);
          if (q && q.right > 0 && q.left < innerWidth) lines.set(Math.round(q.top), (lines.get(Math.round(q.top)) ?? 0) + 1);
        }
        counts.push(...[...lines.values()].slice(0, -1));
      }
      counts.sort((a, b) => a - b);
      return counts[counts.length >> 1];
    });
    rows.push(`${label} ${perLine}`);
    await browser.close();
  }
  ok(rows.every((r) => Number(r.split(' ').pop()) >= 60 && Number(r.split(' ').pop()) <= 76), `about 70 characters a line: ${rows.join(', ')}`);
}


// Scroll mode: what moves the text without the reader (a picture loading
// above, a chunk added above, a jump) isn't reading on, so 'shown' says
// turned: false then (a jump moves the place kept only once the reader reads
// on). The reader's own scrolling is. A selection is told again where it is
// once the text has scrolled under it. A setup that changes only the colours
// leaves the text where it is (page mode too).
async function selfMovedTest(screen) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true, mode: 'scroll' });
  console.log(`\nscroll mode, moved by the page or by the reader (${screen.width}×${screen.height})`);
  const { browser, page, send, take } = await open(screen);
  const uri = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 40;
    c.height = 400;
    c.getContext('2d').fillRect(0, 0, 40, 400);
    return c.toDataURL('image/png');
  });
  const blocks = CHUNKS[1].map((blk, k) => (k === 1 ? { k: 'img', s: 'tall.png' } : blk));
  const withImage = { c: 1, html: gen.chunkHtml(blocks, chunkStart(1), settings, 'en', new Map([['tall.png', { uri, width: 400, height: 40 }]])), chars: chars(blocks) };
  await send(setupMsg('scroll', settings, screen, { at: { b: 110, i: 0 } }, 'm'));
  await send({ t: 'bounds', count: 3, complete: true });
  await send({ t: 'content', chunks: [withImage], target: { at: { b: 110, i: 0 } }, key: 'm' });
  let msgs = await take(600);
  ok(msgs.some((m) => m.t === 'shown') && !msgs.some((m) => m.t === 'shown' && m.turned), `a jump, and a picture above loading: not reading on (${msgs.filter((m) => m.t === 'shown').map((m) => m.turned).join(',')})`);
  await send({ t: 'add', chunks: [chunk(0, settings)] });
  msgs = await take(300);
  ok(!msgs.some((m) => m.t === 'shown' && m.turned), 'a chunk added above: not reading on');
  await page.evaluate(() => scrollBy(0, 400));
  msgs = await take(300);
  ok(msgs.some((m) => m.t === 'shown' && m.turned), 'the reader scrolling on: reading on');
  // A selection, then the text scrolled under it.
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('p[data-b]')].find((x) => x.getBoundingClientRect().top > 300);
    const r = document.createRange();
    r.setStart(el.firstChild, 4);
    r.setEnd(el.firstChild, 12);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  const sel1 = lastOf(await take(300), 'selection');
  await page.evaluate(() => scrollBy(0, 120));
  const sel2 = lastOf(await take(400), 'selection');
  ok(sel1 && sel2 && same(sel1.start, sel2.start) && Math.abs(sel1.startCaret.y - sel2.startCaret.y - 120) < 2, `a selection scrolled under is told again where it is: ${sel1?.startCaret.y.toFixed(0)} -> ${sel2?.startCaret.y.toFixed(0)}`);
  await send({ t: 'clearSelection' });
  await take(300);
  // Another theme only: nothing moves.
  const y0 = await page.evaluate(() => scrollY);
  await send(setupMsg('scroll', settings, screen, { at: { b: 5, i: 0 }, top: true }, 'm', SYSTEM_FONT, { theme: gen.THEMES.sepia }));
  msgs = await take(200);
  ok((await page.evaluate(() => scrollY)) === y0 && !msgs.some((m) => m.t === 'shown'), 'another theme: the text stays where it is');
  await browser.close();
  // Page mode: the same.
  const ps = gen.sanitizeSettings({ hyphenate: true, indent: true });
  const f = frameOf('page', ps, screen);
  const p2 = await open({ width: f.width, height: f.height });
  await p2.send(setupMsg('page', ps, screen, { at: { b: 100, i: 0 } }, 'q'));
  await p2.send({ t: 'bounds', count: 3, complete: true });
  await p2.send({ t: 'content', chunks: [0, 1, 2].map((c) => chunk(c, ps)), target: { at: { b: 100, i: 0 } }, key: 'q' });
  await p2.take(150);
  const t0 = await p2.page.evaluate(() => document.getElementById('strip').style.transform);
  await p2.send(setupMsg('page', ps, screen, { at: { b: 5, i: 0 }, top: true }, 'q', SYSTEM_FONT, { theme: gen.THEMES.sepia }));
  msgs = await p2.take(150);
  ok((await p2.page.evaluate(() => document.getElementById('strip').style.transform)) === t0 && !msgs.some((m) => m.t === 'shown'), 'page mode, another theme: the page stays');
  await p2.browser.close();
}


// 'measure': chunks laid out out of sight, for page numbers: each gets the
// pages it gets on the strip, and nothing on screen changes meanwhile (the
// page, a selection, marks, a turn sliding). A layout that isn't the page's
// gets no answer.
async function measureChunksTest(screen, label) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true });
  const f = frameOf('page', settings, screen);
  console.log(`\npage mode, chunks measured out of sight, ${label} (${f.width}×${f.height}${f.spread ? ', spread' : ''})`);
  const { browser, page, send, take } = await open({ width: f.width, height: f.height });
  await send(setupMsg('page', settings, screen, { at: { b: 100, i: 0 } }, 'm1', SYSTEM_FONT, { turn: 'slide' }));
  await send({ t: 'bounds', count: 5, complete: true });
  await send({ t: 'content', chunks: [0, 1, 2].map((c) => bookChunk(c, settings)), target: { at: { b: 100, i: 0 } }, key: 'm1' });
  const strip = lastOf(await take(200), 'pages').counts;
  // A selection and a mark on the page shown.
  const state = () => page.evaluate(() => ({ transform: document.getElementById('strip').style.transform, selected: getSelection().toString(), marks: globalThis.CSS?.highlights ? [...CSS.highlights.values()].reduce((n, h) => n + h.size, 0) : document.querySelectorAll('span[data-mark]').length, sections: document.querySelectorAll('#strip > .chunk').length }));
  const sel = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-b]')].find((x) => x.getBoundingClientRect().left >= 0 && x.textContent.length > 20);
    const r = document.createRange();
    r.setStart(el.firstChild, 2);
    r.setEnd(el.firstChild, 12);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    return Number(el.dataset.b);
  });
  await send({ t: 'marks', marks: [{ b: sel, s: 0, e: 8, color: '#ffeb3b88' }] });
  await take(300);
  const before = await state();
  await send({ t: 'measure', key: 'm1', chunks: [0, 1, 2, 3].map((c) => bookChunk(c, settings)) });
  let msgs = await take(300);
  const measured = lastOf(msgs, 'measured');
  ok(measured && measured.key === 'm1' && [0, 1, 2].every((c) => measured.counts.find((x) => x.c === c)?.pages === strip.find((x) => x.c === c).pages), `each chunk measured as many pages as it has on the strip: ${JSON.stringify(measured?.counts.map((x) => x.pages))} vs ${JSON.stringify(strip.map((x) => x.pages))}`);
  ok(JSON.stringify(await state()) === JSON.stringify(before) && !msgs.some((m) => m.t === 'shown' || m.t === 'noSelection'), `the page shown, the selection and the marks stay as they were: ${JSON.stringify(before)}`);
  // Chunk 3, measured before it was on the strip: the same once it is.
  await send({ t: 'add', chunks: [bookChunk(3, settings)] });
  const added = lastOf(await take(200), 'pages').counts.find((x) => x.c === 3);
  ok(added && added.pages === measured?.counts.find((x) => x.c === 3)?.pages, `a chunk measured before it came: as many pages as it then has (${added?.pages})`);
  await send({ t: 'clearSelection' });
  await send({ t: 'marks', marks: [] });
  await take(300);
  // Another layout's key: no answer.
  await send({ t: 'measure', key: 'old', chunks: [bookChunk(1, settings)] });
  ok(!(await take(200)).some((m) => m.t === 'measured'), 'asked for another layout: no answer');
  // Asked while a turn slides: it lands where it would have, then the answer comes.
  await send({ t: 'go', target: { at: { b: 100, i: 0 } } });
  const s0 = lastOf(await take(50), 'shown');
  await send({ t: 'turn', dir: 1 });
  await send({ t: 'measure', key: 'm1', chunks: [bookChunk(4, settings)] });
  msgs = await take(500);
  const landed = msgs.findIndex((m) => m.t === 'shown' && m.turned);
  const answered = msgs.findIndex((m) => m.t === 'measured');
  ok(landed >= 0 && answered > landed && same(msgs[landed].first, s0.next), `asked as a turn slides: the turn lands on the next page (${JSON.stringify(msgs[landed]?.first)}), then it's answered`);
  await browser.close();
}


// Lines broken in the book (verse in stanzas, a line break kept in prose: a
// block's text holds '\n'): drawn broken, pages run on through them exactly,
// and a selection across a break is in the block's drawn offsets.
async function lineBreaksTest(screen) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true });
  const f = frameOf('page', settings, screen);
  console.log(`\npage mode, verse and kept line breaks (${f.width}×${f.height})`);
  const stanza = (k) => Array.from({ length: 4 }, (_, l) => words.slice((k + l) % 9, ((k + l) % 9) + 5 + (l % 3)).join(' ')).join('\n');
  const blocks = [{ k: 'h', l: 2, r: ['Songs'] }];
  for (let k = 0; k < 70; k++) blocks.push({ k: 'v', r: [stanza(k)] }, { k: 'sp' });
  blocks.push({ k: 'p', r: ['A paragraph with a line kept\nbroken in it, and then more words after the break.'] });
  const { browser, page, send, take } = await open({ width: f.width, height: f.height });
  await send(setupMsg('page', settings, screen, { at: { b: 0, i: 0 } }, 'v'));
  await send({ t: 'bounds', count: 1, complete: true });
  await send({ t: 'content', chunks: [{ c: 0, html: gen.chunkHtml(blocks, 0, settings, 'en', new Map()), chars: 9000 }], target: { at: { b: 0, i: 0 } }, key: 'v' });
  let s = lastOf(await take(150), 'shown');
  let gaps = 0;
  let wrong = 0;
  let n = 1;
  for (;;) {
    if ((await visible(page, s.first)) !== true || (s.next && (await visible(page, s.next)) === true)) wrong++;
    await send({ t: 'turn', dir: 1 });
    const t = lastOf(await take(15), 'shown');
    if (!t) break;
    if (!same(s.next, t.first)) gaps++;
    s = t;
    n++;
  }
  ok(gaps === 0 && wrong === 0, `${n} pages of verse run on, each one's first character shown and the next's not (${gaps} gaps, ${wrong} wrong)`);
  const drawnBroken = await page.evaluate(() => [...document.querySelectorAll('.v')].every((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    return new Set([...r.getClientRects()].filter((q) => q.width > 0).map((q) => `${Math.round(q.left / 100)}|${Math.round(q.top)}`)).size >= 4;
  }));
  ok(drawnBroken, 'each stanza is drawn in its four lines');
  const last = blocks.length - 1;
  const text = gen.drawn(blocks[last], gen.lookOf(blocks[last], settings, 'en')).text;
  const k = text.indexOf('\n');
  await send({ t: 'go', target: { at: { b: last, i: 0 } } });
  await take(30);
  await page.evaluate(({ b, s, e }) => {
    const t = document.querySelector(`[data-b="${b}"]`).firstChild;
    const r = document.createRange();
    r.setStart(t, s);
    r.setEnd(t, e);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }, { b: last, s: k - 4, e: k + 6 });
  const sel = lastOf(await take(300), 'selection');
  ok(sel && same(sel.start, { b: last, i: k - 4 }) && same(sel.end, { b: last, i: k + 6 }), `a selection across a kept line break: ${JSON.stringify([sel?.start, sel?.end])} (${k - 4}..${k + 6})`);
  await browser.close();
}

// ---- found in review (each failed before its fix) ----

/** Text drawn above a page's top or past its foot, inside the part of the screen pages are drawn in. */
const offPage = (page, h) =>
  page.evaluate((h) => {
    const vp = document.getElementById('viewport').getBoundingClientRect();
    const r = document.createRange();
    const out = [];
    const walker = document.createTreeWalker(document.getElementById('strip'), NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      r.selectNodeContents(t);
      for (const q of r.getClientRects()) if (q.width > 0 && q.right > vp.left + 1 && q.left < vp.right - 1 && (q.top < -1 || q.bottom > h + 1)) out.push(t.parentElement.closest('[data-b]')?.dataset.b);
    }
    return out;
  }, h);

// A heading and the room it keeps under it taller than the page (a long
// title at a big text size, a phone held sideways): Chromium split the room
// onto the next page, and its negative margin pulled the text after it up
// off that page, unread.
async function tallHeadingTest() {
  console.log('\npage mode, a heading as tall as the page with the room it keeps');
  const cases = [
    ['Pixel 7 sideways, text 28', { width: 914.2857, height: 411.4286 }, { top: 0, bottom: 16.7619, left: 0, right: 46.4762 }, { fontSize: 28 }, 'Chapter Twelve, in which the travellers reach the harbour at last', 2.625],
    ['Pixel 7 sideways, text 24', { width: 914.2857, height: 411.4286 }, { top: 0, bottom: 16.7619, left: 0, right: 46.4762 }, { fontSize: 24 }, 'Chapter Twelve, in which the travellers reach the harbour at last and find that nobody is waiting', 2.625],
    ['iPhone sideways, text 30, spacing 2 and 1.5', { width: 852, height: 393 }, { top: 0, bottom: 21, left: 59, right: 59 }, { fontSize: 30, lineSpacing: 2, paraSpacing: 1.5 }, 'Chapter Two', 3],
    ['iPhone sideways, text 40, spacing 2', { width: 852, height: 393 }, { top: 0, bottom: 21, left: 59, right: 59 }, { fontSize: 40, lineSpacing: 2 }, 'Chapter Two', 3],
    ['phone upright, text 40, spacing 2.4 and 1.5', { width: 393, height: 852 }, { top: 47, bottom: 34, left: 0, right: 0 }, { fontSize: 40, lineSpacing: 2.4, paraSpacing: 1.5 }, 'Chapter Two: the Long Way Round by the River', 3],
  ];
  for (const [label, win, insets, extra, title, dpr] of cases) {
    const settings = gen.sanitizeSettings({ hyphenate: true, indent: true, ...extra });
    const frame = gen.webFrame(win, insets, settings.margin, 'page', settings);
    const { browser, page, send, take } = await open({ width: Math.ceil(frame.width), height: frame.height }, { dpr });
    const blocks = [{ k: 'h', l: 1, r: [title] }, ...CHUNKS[0].slice(1, 14), { k: 'h', l: 2, r: [title] }, ...CHUNKS[0].slice(14, 24)];
    await send(setupMsg('page', settings, win, { at: { b: 0, i: 0 } }, 't', SYSTEM_FONT, { frame }));
    await send({ t: 'bounds', count: 1, complete: true });
    await send({ t: 'content', chunks: [{ c: 0, html: gen.chunkHtml(blocks, 0, settings, 'en', new Map()), chars: chars(blocks) }], target: { at: { b: 0, i: 0 } }, key: 't' });
    let s = lastOf(await take(250), 'shown');
    const off = await offPage(page, frame.height);
    let gaps = 0;
    let wrong = 0;
    for (let n = 0; n < 200; n++) {
      if ((await visible(page, s.first)) !== true) wrong++;
      await send({ t: 'turn', dir: 1 });
      const t = lastOf(await take(15), 'shown');
      if (!t) break;
      if (!same(s.next, t.first)) gaps++;
      s = t;
    }
    ok(!off.length && !gaps && !wrong, `${label}: no text drawn off the page (${off.length}: blocks ${[...new Set(off)].join(',')}), each page runs on from the last (${gaps} gaps, ${wrong} first characters not shown)`);
    await browser.close();
  }
}

// Two headings in a row, or a heading and a picture: WebKit ignores
// break-after: avoid, so the room a heading keeps under it must hold what
// comes after it.
async function headingFollowersTest(screen) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true });
  const f = frameOf('page', settings, screen);
  console.log(`\npage mode, headings followed by a heading or a picture (${f.width}×${f.height}${f.spread ? ', spread' : ''})`);
  const { browser, page, send, take } = await open({ width: f.width, height: f.height });
  const uri = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 600;
    c.height = 400;
    c.getContext('2d').fillRect(0, 0, 600, 400);
    return c.toDataURL('image/png');
  });
  await send(setupMsg('page', settings, screen, { at: { b: 0, i: 0 } }, 'h'));
  await send({ t: 'bounds', count: 1, complete: true });
  const total = { heading: [0, 0], picture: [0, 0] };
  for (const kind of ['heading', 'picture']) {
    for (let v = 0; v < 20; v++) {
      const blocks = [];
      for (let k = 0; k < 28; k++) {
        const n = 10 + ((k * 7 + v * 5) % 45);
        blocks.push({ k: 'p', r: [Array.from({ length: n }, (_, j) => words[(j * 3 + k + v) % words.length]).join(' ') + '.'] });
        if (k % 3 === 2) blocks.push({ k: 'h', l: 2, r: [`Part ${k}`] }, kind === 'heading' ? { k: 'h', l: 3, r: [`Section ${k}.1`] } : { k: 'img', s: 'pic' });
      }
      const images = new Map([['pic', { uri, width: 600, height: 400 }]]);
      await send({ t: 'content', chunks: [{ c: 0, html: gen.chunkHtml(blocks, 0, settings, 'en', images), chars: 1 }], target: { at: { b: 0, i: 0 } }, key: 'h' });
      await take(kind === 'picture' ? 60 : 10);
      const r = await page.evaluate(({ pitch, gap, padLeft }) => {
        const sec = document.querySelector('#strip > .chunk');
        const origin = sec.getBoundingClientRect().left + padLeft;
        const col = (x) => Math.floor((x - origin + gap / 2) / pitch);
        let stranded = 0;
        let headings = 0;
        const els = [...sec.children];
        els.forEach((el, k) => {
          if (!/^h\d$/.test(el.classList[0])) return;
          headings++;
          const last = Math.max(...[...el.getClientRects()].map((q) => col(q.left)));
          const next = els[k + 1];
          if (next && col(next.getClientRects()[0].left) !== last) stranded++;
        });
        return [stranded, headings];
      }, { pitch: f.column + f.gap, gap: f.gap, padLeft: f.left - (f.inset?.left ?? 0) });
      total[kind][0] += r[0];
      total[kind][1] += r[1];
    }
  }
  ok(total.heading[0] === 0, `no heading at a page's foot with the next heading on the next page: ${total.heading[0]} of ${total.heading[1]}`);
  ok(total.picture[0] === 0, `no heading at a page's foot with its picture on the next page: ${total.picture[0]} of ${total.picture[1]}`);
  await browser.close();
}

/** A block's whole drawn text, across the parts it may be split into. */
const blockText = (page, b) => page.evaluate((b) => [...document.querySelectorAll(`[data-b="${b}"]`)].map((x) => x.textContent).join(''), b);

// A layout change at a place in the last paragraph of a chunk, then the
// chunk going on from it arrives (the paragraph made one again across them):
// the page shown stays, a selection and a mark there are at their places.
async function placeThenJoinedTest(screen) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true });
  const f = frameOf('page', settings, screen);
  console.log(`\npage mode, laid out again at a chunk's last paragraph, then the chunk going on from it (${f.width}×${f.height})`);
  const text = (n, k) => Array.from({ length: n }, (_, j) => words[(j * 7 + k) % words.length]).join(' ');
  const c0 = BOOK[0].slice(0, 59).concat([{ k: 'p', r: [`§cut ${text(400, 1)} `] }]);
  const c1 = [{ k: 'p', c: 1, r: [`${text(120, 2)}.`] }, ...BOOK[1].slice(1, 60)];
  const ch = (c, blocks, joins) => ({ c, html: gen.chunkHtml(blocks, c * 60, settings, 'en', new Map()), chars: chars(blocks), joins });
  const { browser, page, send, take } = await open({ width: f.width, height: f.height });
  await send(setupMsg('page', settings, screen, { at: { b: 0, i: 0 } }, 'k'));
  await send({ t: 'bounds', count: 1, complete: false });
  await send({ t: 'content', chunks: [ch(0, c0)], target: { at: { b: 59, i: 1500 } }, key: 'k' });
  await take(150);
  const deep = await page.evaluate((h) => {
    const t = document.querySelector('[data-b="59"]').firstChild;
    for (let k = 600; k < t.data.length; k += 3) {
      const r = document.createRange();
      r.setStart(t, k);
      r.setEnd(t, k + 1);
      const q = r.getBoundingClientRect();
      if (q.height && q.left >= 0 && q.right <= innerWidth && q.top > h * 0.45 && q.top < h * 0.65) return { b: 59, i: k };
    }
    return null;
  }, f.height);
  await send(setupMsg('page', gen.sanitizeSettings({ hyphenate: true, indent: true, fontSize: 21 }), screen, { at: deep, top: true }, 'k2'));
  const s1 = lastOf(await take(150), 'shown');
  const full = await blockText(page, 59);
  await send({ t: 'bounds', count: 2, complete: false });
  await send({ t: 'add', chunks: [ch(1, c1, true)] });
  const s2 = lastOf(await take(150), 'shown');
  const parts = await page.evaluate(() => document.querySelectorAll('[data-b="59"]').length);
  ok(s1 && s2 && same(s1.first, s2.first) && parts === 1 && (await visible(page, deep)) === true, `the page shown stays where it was (${JSON.stringify(s1?.first)} -> ${JSON.stringify(s2?.first)}), the place on it`);
  await page.evaluate((k) => {
    const t = document.querySelector('[data-b="59"]').firstChild;
    const r = document.createRange();
    r.setStart(t, k);
    r.setEnd(t, k + 10);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }, deep.i);
  const selMsg = lastOf(await take(300), 'selection');
  ok(selMsg && same(selMsg.start, deep) && same(selMsg.end, { b: 59, i: deep.i + 10 }), `a selection there is at its place in the block: ${JSON.stringify([selMsg?.start, selMsg?.end])}`);
  await send({ t: 'clearSelection' });
  await take(200);
  await send({ t: 'marks', marks: [{ b: 59, s: deep.i, e: deep.i + 12, color: '#ffeb3b88' }] });
  const marked = await page.evaluate(() => (globalThis.CSS?.highlights ? [...CSS.highlights.values()].flatMap((h) => [...h]).map((r) => r.toString()).join('|') : [...document.querySelectorAll('span[data-mark]')].map((x) => x.textContent).join('|')));
  ok(marked === full.slice(deep.i, deep.i + 12), `a mark there covers its text: ${JSON.stringify(marked)}`);
  await send({ t: 'marks', marks: [] });
  await browser.close();
}

// A new reading font whose files take a moment, and a tap that turns the page
// meanwhile: the turn lands in the old layout or after the place read in the
// new one, never before it (it used to land on its old screen in the new layout).
async function fontRaceTest(screen) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true });
  const f = frameOf('page', settings, screen);
  console.log(`\npage mode, a page turned while a new font loads (${f.width}×${f.height})`);
  const dirs = { r: '400Regular/Literata_400Regular.ttf', i: '400Regular_Italic/Literata_400Regular_Italic.ttf', b: '700Bold/Literata_700Bold.ttf', bi: '700Bold_Italic/Literata_700Bold_Italic.ttf' };
  const slow = (k, w, st) => `@font-face{font-family:'nec-slow';src:url('http://slow.test/${k}.ttf');font-weight:${w};font-style:${st};}`;
  const SLOW = { css: slow('r', 400, 'normal') + slow('i', 400, 'italic') + slow('b', 700, 'normal') + slow('bi', 700, 'italic'), family: "'nec-slow', serif", medium: false };
  for (const turn of ['slide', 'fade']) {
    const { browser, page, send, take } = await open({ width: f.width, height: f.height });
    let tapped = null;
    await page.route('http://slow.test/**', async (route) => {
      const k = route.request().url().split('/').pop().replace('.ttf', '');
      if (!tapped) tapped = new Promise((r) => setTimeout(r, 300)).then(() => page.touchscreen.tap(f.width - 10, f.height / 2)).then(() => new Promise((r) => setTimeout(r, 60)));
      await tapped;
      await route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'font/ttf' }, body: readFileSync(join(LITERATA, dirs[k])) });
    });
    await send(setupMsg('page', settings, screen, { at: { b: 100, i: 0 } }, 'k1', SYSTEM_FONT, { turn }));
    await send({ t: 'bounds', count: 3, complete: true });
    await send({ t: 'content', chunks: [0, 1, 2].map((c) => chunk(c, settings)), target: { at: { b: 100, i: 0 } }, key: 'k1' });
    const anchor = lastOf(await take(200), 'shown').first;
    await send(setupMsg('page', settings, screen, { at: anchor, top: true }, 'k2', SLOW, { turn }));
    const shown = (await take(1200)).filter((m) => m.t === 'shown');
    const early = shown.filter((m) => m.key === 'k2' && m.turned && before(m.first, anchor));
    ok(shown.some((m) => m.key === 'k2') && !early.length, `${turn}: a turn while the font loads doesn't land before the place read: ${shown.map((m) => `${m.key}${m.turned ? ' turned' : ''} ${JSON.stringify(m.first)}`).join(' | ')}`);
    await browser.close();
  }
}

// Two layout changes in a row: the highlights are still drawn after the second.
async function marksAfterRelayoutTest(screen) {
  const S = (fontSize) => gen.sanitizeSettings({ hyphenate: true, indent: true, fontSize });
  const f = frameOf('page', S(19), screen);
  console.log(`\npage mode, highlights after two layout changes (${f.width}×${f.height})`);
  const { browser, page, send, take } = await open({ width: f.width, height: f.height });
  await send({ t: 'bounds', count: 3, complete: true });
  await send(setupMsg('page', S(21), screen, { at: { b: 100, i: 0 } }, 'x'));
  await send({ t: 'content', chunks: [0, 1, 2].map((c) => chunk(c, S(21))), target: { at: { b: 120, i: 0 } }, key: 'x' });
  await take(120);
  await send({ t: 'turn', dir: 1 });
  const T = lastOf(await take(60), 'shown').first;
  await send(setupMsg('page', S(23), screen, { at: T }, 'k1'));
  await send({ t: 'content', chunks: [0, 1, 2].map((c) => chunk(c, S(23))), target: { at: T }, key: 'k1' });
  await take(120);
  const deep = await page.evaluate((h) => {
    for (const el of document.querySelectorAll('p[data-b]')) {
      const n = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
      for (let k = 8; n && k < n.data.length; k += 3) {
        const r = document.createRange();
        r.setStart(n, k);
        r.setEnd(n, k + 1);
        const b = r.getBoundingClientRect();
        if (b.height && b.left >= 0 && b.right <= innerWidth && b.top > h * 0.4 && b.top < h * 0.8) return { b: Number(el.dataset.b), i: k };
      }
    }
    return null;
  }, f.height);
  const marks = { t: 'marks', marks: [{ b: T.b, s: T.i, e: T.i + 30, color: '#ffeb3b' }, { b: deep.b, s: 0, e: 40, color: '#ffeb3b' }] };
  await send(marks);
  await send(setupMsg('page', S(23), screen, { at: deep, top: true }, 'k2'));
  await take(120);
  await send(marks);
  await send(setupMsg('page', S(21), screen, { at: T, top: true }, 'k3'));
  await take(150);
  const drawn = await page.evaluate(() => (globalThis.CSS?.highlights ? [...CSS.highlights.values()].reduce((n, h) => n + [...h].filter((r) => !r.collapsed && r.startContainer.isConnected).length, 0) : document.querySelectorAll('span[data-mark]').length));
  const spot = await charAt(page, T.b, T.i + 3);
  ok(drawn >= 2 && yellowish(await pixel(page, spot.x, spot.y)), `the highlights are drawn after the second change (${drawn} of 2 ranges, the first painted)`);
  await browser.close();
}

// Auto-scroll at the end of what's converted (the next chunk not there yet),
// then the chunk arriving: the text goes on from where it stopped.
async function autoStuckTest(screen) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true, mode: 'scroll' });
  console.log(`\nscroll mode, auto-scroll waiting for the next chunk (${screen.width}×${screen.height})`);
  const { browser, page, send, take } = await open(screen);
  await send(setupMsg('scroll', settings, screen, { at: { b: 70, i: 0 } }, 'a'));
  await send({ t: 'bounds', count: 1, complete: false });
  await send({ t: 'content', chunks: [chunk(0, settings)], target: { at: { b: 70, i: 0 } }, key: 'a' });
  await take(200);
  await send({ t: 'auto', speed: 120 });
  await page.waitForFunction(() => scrollY + innerHeight >= document.documentElement.scrollHeight - 1, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const stuck = await page.evaluate(() => scrollY);
  // The book grows; the chunk itself comes a moment later.
  await send({ t: 'bounds', count: 2, complete: false });
  await page.waitForTimeout(150);
  await send({ t: 'add', chunks: [chunk(1, settings)] });
  const ys = await page.evaluate(() => new Promise((r) => {
    const out = [];
    const f = () => {
      out.push(scrollY);
      if (out.length < 6) requestAnimationFrame(f);
      else r(out);
    };
    requestAnimationFrame(f);
  }));
  await send({ t: 'auto', speed: 0 });
  // At 120 pt/s, 2 points a frame: every frame from where it stopped, none ahead of it.
  ok(ys.every((y, k) => y >= stuck - 2 && y <= stuck + 10 + 3 * k), `stuck at ${stuck}, the next chunk came: on from there (${ys.join(', ')})`);
  await browser.close();
}

// Taps quicker than a turn's slide: every one turns a page (a tap lands the
// slide going at once and turns again), never a chunk away, also with the
// screen's chunk messages arriving meanwhile.
async function rapidTapsTest(screen) {
  const settings = gen.sanitizeSettings({ hyphenate: true, indent: true });
  const f = frameOf('page', settings, screen);
  console.log(`\npage mode, taps quicker than a turn (${f.width}×${f.height})`);
  for (const turn of ['slide', 'fade']) {
    const { browser, page, send, take } = await open({ width: f.width, height: f.height });
    await send(setupMsg('page', settings, screen, { at: { b: 0, i: 0 } }, 'r', SYSTEM_FONT, { turn }));
    await send({ t: 'bounds', count: 5, complete: true });
    // Near the end of chunk 1: the taps go on into chunk 2.
    await send({ t: 'content', chunks: [0, 1, 2, 3].map((c) => bookChunk(c, settings)), target: { chunk: 1, edge: 'last' }, key: 'r' });
    await take(150);
    await send({ t: 'turn', dir: -1 });
    await send({ t: 'turn', dir: -1 });
    const s0 = [...(await take(600))].reverse().find((m) => m.t === 'shown');
    const want = [];
    for (let k = 0; k < 6; k++) {
      await send({ t: 'turn', dir: 1 });
      want.push([...(await take(400))].reverse().find((m) => m.t === 'shown' && m.turned)?.first);
    }
    await send({ t: 'go', target: { at: s0.first } });
    await take(100);
    for (let k = 0; k < 6; k++) {
      await page.touchscreen.tap(f.width - 12, f.height / 2);
      if (k === 2) await send({ t: 'drop', chunks: [0] });
      if (k === 3) await send({ t: 'add', chunks: [bookChunk(4, settings)] });
      await page.waitForTimeout(90);
    }
    const landed = (await take(700)).filter((m) => m.t === 'shown' && m.turned).map((m) => m.first);
    ok(landed.length === 6 && landed.every((p, k) => same(p, want[k])), `${turn}: 6 taps 90 ms apart turn 6 pages, each the next (${landed.length} turned; ${landed.filter((p, k) => !same(p, want[k])).length} elsewhere)`);
    await browser.close();
  }
}

// From scroll mode to pages (the owner's rule): the page shown is the one
// holding the place read, as reached by turning; the line read is marked.
async function modeSwitchTest(screen) {
  const page0 = gen.sanitizeSettings({ hyphenate: true, indent: true });
  const scroll = gen.sanitizeSettings({ hyphenate: true, indent: true, mode: 'scroll' });
  const f = frameOf('page', page0, screen);
  console.log(`\nscroll mode to pages (${screen.width}×${screen.height})`);
  // The pages, as reached by turning.
  const p = await open({ width: f.width, height: f.height });
  await p.send(setupMsg('page', page0, screen, { at: { b: 0, i: 0 } }, 'p'));
  await p.send({ t: 'bounds', count: 3, complete: true });
  await p.send({ t: 'content', chunks: [0, 1, 2].map((c) => chunk(c, page0)), target: { at: { b: 0, i: 0 } }, key: 'p' });
  const turned = [lastOf(await p.take(150), 'shown')];
  for (;;) {
    await p.send({ t: 'turn', dir: 1 });
    const n = lastOf(await p.take(15), 'shown');
    if (!n) break;
    turned.push(n);
  }
  await p.browser.close();
  // Scroll mode, scrolled to a place in the middle of a paragraph; then pages, at that place.
  const { browser, page, send, take } = await open({ width: f.width, height: f.height });
  await send(setupMsg('scroll', scroll, screen, { at: { b: 100, i: 0 } }, 's'));
  await send({ t: 'bounds', count: 3, complete: true });
  await send({ t: 'content', chunks: [0, 1, 2].map((c) => chunk(c, scroll)), target: { at: { b: 100, i: 0 } }, key: 's' });
  await take(150);
  await page.evaluate(() => scrollBy(0, 1234));
  const place = lastOf(await take(200), 'shown').first;
  await send(setupMsg('page', page0, screen, { at: place, top: true }, 'p'));
  await send({ t: 'content', chunks: [0, 1, 2].map((c) => chunk(c, page0)), target: { at: place, top: true }, key: 'p' });
  const s = lastOf(await take(200), 'shown');
  const k = turned.findIndex((x) => same(x.first, s?.first));
  const holds = k >= 0 && !before(place, turned[k].first) && (!turned[k].next || before(place, turned[k].next));
  const mark = await page.evaluate(() => document.querySelector('#viewport > .flash')?.getBoundingClientRect().toJSON());
  const at = await charAt(page, place.b, place.i);
  ok(holds && mark && mark.top <= at.y && mark.bottom >= at.y, `the page shown (${k + 1} of ${turned.length}) is the one holding the place read ${JSON.stringify(place)}, as reached by turning; its line marked`);
  await browser.close();
}

await pagedTest({ width: 393, height: 852 }, 'phone');
await pagedTest({ width: 852, height: 393 }, 'landscape');
await webFontTest({ width: 393, height: 852 });
await laterChunkTest({ width: 393, height: 852 });
await imageTest({ width: 393, height: 852 });
await scrollTest({ width: 393, height: 852 });
await scrollImageTest({ width: 393, height: 852 });
await turnRaceTest({ width: 393, height: 852 });
await joinTest({ width: 393, height: 852 }, 'phone');
await joinTest({ width: 852, height: 393 }, 'landscape');
await autoScrollTest({ width: 393, height: 852 });
await pictureTest({ width: 852, height: 393 });
await longParagraphTest({ width: 393, height: 852 });
await loneLinesTest({ width: 393, height: 852 });
await loneLinesTest({ width: 852, height: 393 });
await languageTest({ width: 393, height: 852 });
await fontLoadTest({ width: 393, height: 852 });
await footnoteTest({ width: 393, height: 852 });
await bookStylesTest({ width: 393, height: 852 });
await selectionEdgesTest({ width: 393, height: 852 });
await touchTest({ width: 393, height: 852 });
await scrollPlaceTest({ width: 393, height: 852 });
await spreadTest();
await measureTest();
await selfMovedTest({ width: 393, height: 852 });
await measureChunksTest({ width: 393, height: 852 }, 'phone');
await measureChunksTest({ width: 852, height: 393 }, 'landscape');
await lineBreaksTest({ width: 393, height: 852 });
await tallHeadingTest();
await headingFollowersTest({ width: 393, height: 852 });
await headingFollowersTest({ width: 852, height: 393 });
await placeThenJoinedTest({ width: 393, height: 852 });
await fontRaceTest({ width: 393, height: 852 });
await marksAfterRelayoutTest({ width: 393, height: 852 });
await autoStuckTest({ width: 393, height: 852 });
await rapidTapsTest({ width: 393, height: 852 });
await modeSwitchTest({ width: 393, height: 852 });
console.log(failures ? `\n${failures} FAILED (${ENGINE})` : `\nall passed (${ENGINE})`);
process.exit(failures ? 1 : 0);
