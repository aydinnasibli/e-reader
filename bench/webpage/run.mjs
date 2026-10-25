// The reader page (src/reader/web/page) in real browser engines: Chromium
// (Android's WebView) and WebKit (the iPhone's), fed with HTML and CSS made by
// the app's own code. Checks what the screen relies on: page continuity (every
// page starts where the last ended, and that text is really on screen), jumps,
// reopening at a page's start, staying on the place after a text size change,
// a web font that loads late or a picture that changes shape, selection,
// marks, touches, the highlight tool, spreads, scroll mode.
//
//   npx playwright-core install chromium webkit   # once
//   npm run test:page                             # both engines
//   ENGINE=webkit node bench/webpage/run.mjs      # one

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const PAGE_FILE = join(OUT, 'webpage.html');
writeFileSync(PAGE_FILE, PAGE_HTML);

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
function setupMsg(mode, settings, screen, target, key, font = SYSTEM_FONT) {
  const frame = frameOf(mode, settings, screen);
  const theme = gen.THEMES.light;
  return { t: 'setup', key, target, setup: { mode, frame, css: gen.bookCss(settings, theme, frame, font, mode), turn: 'none', tapForward: false, processing: 'Preparing…', theEnd: '— The End —' } };
}
const before = (a, b) => a.b < b.b || (a.b === b.b && a.i < b.i);
const same = (a, b) => a && b && a.b === b.b && a.i === b.i;

async function open(win, { touch = true } = {}) {
  const browser = ENGINE === 'webkit' ? await webkit.launch() : await chromium.launch({ executablePath: chromePath(), headless: true });
  const ctx = await browser.newContext({ viewport: win, hasTouch: touch, isMobile: true, deviceScaleFactor: 3 });
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

// What the page really shows: is a drawn point's character inside the screen?
async function visible(page, p) {
  return page.evaluate((p) => {
    const el = document.querySelector(`[data-b="${p.b}"]`);
    if (!el) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let left = p.i;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (left < n.data.length) {
        const r = document.createRange();
        r.setStart(n, left);
        r.setEnd(n, left + 1);
        const box = [...r.getClientRects()].find((x) => x.height > 0);
        if (!box) return 'invisible';
        return box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1;
      }
      left -= n.data.length;
    }
    // An element without text (a rule, an image).
    const r = el.getBoundingClientRect();
    return r.left >= -1 && r.left < innerWidth;
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

  // A bigger text size: laid out again, still on the page holding the place.
  const anchor = { b: 120, i: 50 };
  await send({ t: 'go', target: { at: anchor } });
  await take(30);
  const bigger = gen.sanitizeSettings({ hyphenate: true, indent: true, fontSize: 26 });
  await send(setupMsg('page', bigger, screen, { at: anchor }, 'k2'));
  const s2 = lastOf(await take(100), 'shown');
  ok(s2 && s2.key === 'k2' && !before(anchor, s2.first) && (!s2.next || before(anchor, s2.next)), `after a text size change, the page holding the place: ${JSON.stringify(s2?.first)}..${JSON.stringify(s2?.next)}`);

  // Selection: the browser's, reported in drawn offsets with carets on screen (text on the page shown).
  const selB = s2.first.b + 1;
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
  await send({ t: 'add', chunks: [chunk(2, settings)] });
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

await pagedTest({ width: 393, height: 852 }, 'phone');
await pagedTest({ width: 852, height: 393 }, 'landscape');
await webFontTest({ width: 393, height: 852 });
await imageTest({ width: 393, height: 852 });
await scrollTest({ width: 393, height: 852 });
await scrollImageTest({ width: 393, height: 852 });
console.log(failures ? `\n${failures} FAILED (${ENGINE})` : `\nall passed (${ENGINE})`);
process.exit(failures ? 1 : 0);
