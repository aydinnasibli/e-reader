// Stress benchmark for the book engine. Builds huge synthetic books in memory
// and converts them, reporting total time, the longest uninterrupted stretch
// of work (what a user would feel as a stutter) and memory.
//
// Runs under Node and under the Hermes CLI (the JS engine React Native uses
// on phones). See bench/README.md.

import { deflateSync } from 'fflate';
import { createDecoder } from '../src/engine/decode';
import type { BookSink, ByteSource, IngestContext } from '../src/engine/io';
import { ingestBook } from '../src/engine/ingest';
import { buildMobi, fakeJpeg } from '../test/mobiFixture';

declare const print: ((...a: unknown[]) => void) | undefined;
declare const HermesInternal: { getInstrumentedStats(): Record<string, number> } | undefined;
declare const process: { memoryUsage(): { heapUsed: number; arrayBuffers: number } } | undefined;
declare const BENCH_FIXTURE: { chapterB64: string; chapterSize: number };
declare const BENCH_ONLY: string | undefined;

const log = (...a: unknown[]) => (typeof print === 'function' ? print(...a) : console.log(...a));
const MB = 1024 * 1024;

// ---------- deterministic text generation ----------

let seed = 42;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const EN = 'the of and to in a is that it was he for on are as with his they at be this from have or by one had not but what all were when we there can an your which their said if do will each about how up out them then she many some so these would other into has more her two like him see time could no make than first been its who now people my made over did down only way find use may water long little very after words called just where most know'.split(' ');
const TR = 'bir ve bu da de ne için ile ama çok gibi daha o ben sen ki mi diye kadar her şey değil ağaç gölge yaşlı adam eski sokak düşünce ışık kapı deniz kıyı ev pencere lamba çocuk arkadaş şimdi koku süre ağır adım gökyüzü yıldız sabah çay masa balkon kadın çamaşır gazete gün dükkân börek okul çarşı kalabalık akşam rüzgâr yaprak gece uyku fotoğraf hikâye şafak hava nefes'.split(' ');
const RU = 'и в не на я быть он с что а по это она этот к но они мы как из у который то за свой что весь год от так о для ты же все тот мочь вы человек такой его сказать только или ещё бы себя один как уже до время если сам когда другой вот говорить наш мой знать стать при чтобы дело жизнь кто первый очень два день её новый рука даже во раз где там под можно ну какой после их работа без самый потом надо хотеть ли слово идти большой должен место иметь ничто'.split(' ');

function sentence(words: string[]) {
  const n = 6 + Math.floor(rand() * 18);
  let s = '';
  for (let i = 0; i < n; i++) s += (i ? ' ' : '') + words[Math.floor(rand() * words.length)];
  return s[0].toUpperCase() + s.slice(1) + (rand() < 0.1 ? '?' : '.');
}

function paragraph(words: string[]) {
  const n = 2 + Math.floor(rand() * 7);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(sentence(words));
  return out.join(' ');
}

function wrap(p: string, width: number) {
  const lines: string[] = [];
  let line = '';
  for (const w of p.split(' ')) {
    if (line && line.length + w.length + 1 > width) {
      lines.push(line);
      line = w;
    } else line = line ? line + ' ' + w : w;
  }
  if (line) lines.push(line);
  return lines.join('\r\n');
}

function utf8(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 3);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) out[n++] = c;
    else if (c < 0x800) {
      out[n++] = 0xc0 | (c >> 6);
      out[n++] = 0x80 | (c & 63);
    } else {
      out[n++] = 0xe0 | (c >> 12);
      out[n++] = 0x80 | ((c >> 6) & 63);
      out[n++] = 0x80 | (c & 63);
    }
  }
  return out.slice(0, n);
}

function oneByte(s: string, enc: 'windows-1251' | 'windows-1254'): Uint8Array {
  const d = createDecoder(enc, false);
  const rev = new Map<number, number>();
  for (let b = 0; b < 256; b++) rev.set(d.decode(new Uint8Array([b])).charCodeAt(0), b);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = rev.get(s.charCodeAt(i)) ?? 63;
  return out;
}

function tile(unit: Uint8Array, times: number, prefix: Uint8Array = new Uint8Array(0), suffix: Uint8Array = new Uint8Array(0)) {
  const out = new Uint8Array(prefix.length + unit.length * times + suffix.length);
  out.set(prefix);
  for (let i = 0; i < times; i++) out.set(unit, prefix.length + i * unit.length);
  out.set(suffix, prefix.length + unit.length * times);
  return out;
}

function concat(parts: Uint8Array[]) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const map = new Uint8Array(128);
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < 64; i++) map[abc.charCodeAt(i)] = i;
  const clean = b64.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = map[clean.charCodeAt(i)], b = map[clean.charCodeAt(i + 1)];
    const c = map[clean.charCodeAt(i + 2)], d = map[clean.charCodeAt(i + 3)];
    out[o++] = (a << 2) | (b >> 4);
    if (i + 2 < clean.length) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (i + 3 < clean.length) out[o++] = ((c & 3) << 6) | d;
  }
  return out;
}

// ---------- book builders ----------

/** English TXT, hard-wrapped at 72 columns, blank lines between paragraphs. */
export function makeEnglishTxt(totalMB: number) {
  const parts: string[] = [];
  let size = 0;
  let ch = 1;
  while (size < MB) {
    if (size % (100 * 1024) < 1500) parts.push(`Chapter ${ch++}`);
    const p = wrap(paragraph(EN), 72);
    parts.push(p);
    size += p.length + 4;
  }
  return tile(utf8(parts.join('\r\n\r\n') + '\r\n\r\n'), totalMB);
}

/** Russian TXT in windows-1251, one paragraph per line, indented (lib.ru style). */
export function makeRussianTxt(totalMB: number) {
  const parts: string[] = [];
  let size = 0;
  let ch = 1;
  while (size < MB) {
    if (size % (100 * 1024) < 600) parts.push(`     Глава ${ch++}`);
    const p = '     ' + paragraph(RU);
    parts.push(p);
    size += p.length + 2;
  }
  return tile(oneByte(parts.join('\r\n') + '\r\n', 'windows-1251'), totalMB);
}

/** Turkish TXT in windows-1254, hard-wrapped at 70 with no blank lines, paragraphs indented. */
export function makeTurkishTxt(totalMB: number) {
  const parts: string[] = [];
  let size = 0;
  let ch = 1;
  while (size < MB) {
    if (size % (100 * 1024) < 600) parts.push(`${ch++}. BÖLÜM`);
    const p = '    ' + wrap(paragraph(TR), 66);
    parts.push(p);
    size += p.length + 2;
  }
  return tile(oneByte(parts.join('\r\n') + '\r\n', 'windows-1254'), totalMB);
}

/** Minimal ZIP writer. Data is stored, or already raw-deflated when `deflated` is given. */
function zip(files: { name: string; data: Uint8Array; size?: number; deflated?: boolean }[]) {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = utf8(f.name);
    const h = new Uint8Array(30 + name.length);
    const dv = new DataView(h.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x800, true);
    dv.setUint16(8, f.deflated ? 8 : 0, true);
    dv.setUint32(18, f.data.length, true);
    dv.setUint32(22, f.size ?? f.data.length, true);
    dv.setUint16(26, name.length, true);
    h.set(name, 30);
    const c = new Uint8Array(46 + name.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, f.deflated ? 8 : 0, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.size ?? f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    c.set(name, 46);
    local.push(h, f.data);
    central.push(c);
    offset += h.length + f.data.length;
  }
  const cd = concat(central);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cd.length, true);
  ev.setUint32(16, offset, true);
  return concat([...local, cd, end]);
}

export function giantChapterHtml(totalMB: number) {
  const parts: string[] = ['<h1>The Giant Chapter</h1>'];
  let size = 0;
  while (size < MB) {
    const p = `<p>${paragraph(EN).replace(/ (\w+) (\w+)\./, ' <i>$1</i> <b>$2</b>.')}</p>\n`;
    parts.push(p);
    size += p.length;
  }
  const unit = utf8(parts.join(''));
  return tile(unit, totalMB, utf8('<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title><style>p{margin:0}</style></head><body>'), utf8('</body></html>'));
}

/**
 * EPUB with one giant chapter (pre-deflated, passed in), many small chapters,
 * and lots of large images - the kind of file that makes other readers hang.
 */
export function makeEpub(giant: { data: Uint8Array; size: number }, smallChapters: number, images: number, imageMB: number) {
  const files: { name: string; data: Uint8Array; size?: number; deflated?: boolean }[] = [];
  files.push({ name: 'mimetype', data: utf8('application/epub+zip') });
  files.push({
    name: 'META-INF/container.xml',
    data: utf8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
  });
  let items = '<item id="giant" href="giant.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>';
  let spine = '<itemref idref="giant"/>';
  let nav = '<li><a href="giant.xhtml">The Giant Chapter</a></li>';
  for (let i = 0; i < images; i++) items += `<item id="img${i}" href="img/i${i}.jpg" media-type="image/jpeg"/>`;
  const img = new Uint8Array(imageMB * MB);
  for (let i = 0; i < images; i++) files.push({ name: `OEBPS/img/i${i}.jpg`, data: img });
  for (let c = 0; c < smallChapters; c++) {
    let html = `<?xml version="1.0" encoding="utf-8"?><html><body><h2>Chapter ${c + 1}</h2>`;
    while (html.length < 20_000) html += `<p>${paragraph(EN)}</p>`;
    if (c < images) html += `<p><img src="img/i${c}.jpg"/></p>`;
    html += '</body></html>';
    const raw = utf8(html);
    files.push({ name: `OEBPS/c${c}.xhtml`, data: deflateSync(raw), size: raw.length, deflated: true });
    items += `<item id="c${c}" href="c${c}.xhtml" media-type="application/xhtml+xml"/>`;
    spine += `<itemref idref="c${c}"/>`;
    nav += `<li><a href="c${c}.xhtml">Chapter ${c + 1}</a></li>`;
  }
  files.push({ name: 'OEBPS/giant.xhtml', data: giant.data, size: giant.size, deflated: true });
  files.push({ name: 'OEBPS/nav.xhtml', data: utf8(`<html><body><nav epub:type="toc"><ol>${nav}</ol></nav></body></html>`) });
  files.push({
    name: 'OEBPS/content.opf',
    data: utf8(`<?xml version="1.0"?><package><metadata><dc:title>Stress Test</dc:title><dc:creator>Bench</dc:creator></metadata><manifest>${items}</manifest><spine>${spine}</spine></package>`),
  });
  return zip(files);
}

/** UTF-8 FB2 with many sections and big embedded base64 images. */
export function makeFb2(totalMB: number, images: number, imageMB: number) {
  const parts: string[] = [];
  let size = 0;
  let s = 1;
  while (size < MB) {
    let sec = `<section><title><p>Глава ${s++}</p></title>`;
    for (let i = 0; i < 20; i++) sec += `<p>${paragraph(RU).replace(/ (\S+)\./, ' <emphasis>$1</emphasis>.')}</p>`;
    sec += '<empty-line/><poem><stanza><v>Строка стиха</v><v>Ещё строка</v></stanza></poem></section>';
    parts.push(sec);
    size += sec.length * 2;
  }
  const head = utf8(
    '<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info>' +
      '<author><first-name>Тест</first-name><last-name>Автор</last-name></author><book-title>Большая книга</book-title>' +
      '<coverpage><image l:href="#img0"/></coverpage></title-info></description><body>',
  );
  const body = tile(utf8(parts.join('')), totalMB);
  const b64line = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo='.slice(0, 32).repeat(2) + '\n';
  const imgText = b64line.repeat(Math.floor((imageMB * MB) / b64line.length));
  const bins: string[] = [];
  for (let i = 0; i < images; i++) bins.push(`<binary id="img${i}" content-type="image/jpeg">${imgText}</binary>`);
  return concat([head, body, utf8('</body>' + bins.join('') + '</FictionBook>')]);
}

// ---------- measurement ----------

class MemSource implements ByteSource {
  constructor(private b: Uint8Array) {}
  get size() {
    return this.b.length;
  }
  read(o: number, n: number) {
    return this.b.slice(o, o + n);
  }
}

class CountingSink implements BookSink {
  chunks = 0;
  bytes = 0;
  images = 0;
  sample: string[] = [];
  writeChunk(_i: number, json: string) {
    this.chunks++;
    this.bytes += json.length;
    if (this.sample.length < 40) this.sample.push(json);
  }
  writeImage() {
    this.images++;
  }
  writeImageBase64() {
    this.images++;
  }
}

function memMB(): number {
  if (typeof HermesInternal !== 'undefined') return HermesInternal.getInstrumentedStats().js_heapSize / MB;
  if (typeof process !== 'undefined') return process.memoryUsage().heapUsed / MB;
  return 0;
}

async function measure(label: string, fileName: string, bytes: Uint8Array) {
  const sink = new CountingSink();
  let maxSlice = 0;
  let peak = memMB();
  let last = Date.now();
  const ctx: IngestContext = {
    src: new MemSource(bytes),
    sink,
    progress() {},
    pause: async () => {
      const t = Date.now();
      if (t - last > maxSlice) maxSlice = t - last;
      const m = memMB();
      if (m > peak) peak = m;
      await Promise.resolve();
      last = Date.now();
    },
    fallbackTitle: label,
  };
  const t0 = Date.now();
  const m = await ingestBook(ctx, fileName);
  const t1 = Date.now();
  if (t1 - last > maxSlice) maxSlice = t1 - last;

  // Reader side: cost of loading one chunk (read + JSON.parse) when you open the book or turn into a new chunk.
  let parseMax = 0;
  let parseSum = 0;
  for (const s of sink.sample) {
    const p0 = Date.now();
    JSON.parse(s);
    const d = Date.now() - p0;
    parseSum += d;
    if (d > parseMax) parseMax = d;
  }
  const secs = (t1 - t0) / 1000;
  log(
    `${label.padEnd(34)} ${(bytes.length / MB).toFixed(0).padStart(5)} MB file | ${secs.toFixed(1).padStart(6)} s total | ` +
      `${(bytes.length / MB / secs).toFixed(1).padStart(5)} MB/s | longest freeze ${String(maxSlice).padStart(4)} ms | ` +
      `heap peak ${peak.toFixed(0).padStart(4)} MB | ${m.totalBlocks} blocks, ${sink.chunks} chunks, ${m.toc.length} toc | ` +
      `chunk load avg ${(parseSum / Math.max(1, sink.sample.length)).toFixed(1)} ms max ${parseMax} ms`,
  );
}

/** A Kindle book: chapters of English text, PalmDOC-compressed, with images. */
export function makeMobi(totalMB: number, images: number) {
  // An 8 KB unit (page break, heading, paragraphs) repeated, so its 4 KB text
  // records repeat and the generator compresses each kind once.
  let unit = '<mbp:pagebreak/><h2>Chapter</h2>';
  for (;;) {
    const p = `<p>${sentence(EN)} ${sentence(EN)}</p>`;
    if (unit.length + p.length > 8192) break;
    unit += p;
  }
  unit = unit.padEnd(8192, ' ');
  const imgs: Uint8Array[] = [];
  for (let i = 0; i < images; i++) imgs.push(fakeJpeg(i));
  return buildMobi({ html: unit.repeat(totalMB * 128), title: 'Big Kindle book', author: 'Bench', images: imgs, cover: 0, trailing: true });
}

export async function main() {
  const only = typeof BENCH_ONLY === 'string' ? BENCH_ONLY : '';
  const want = (k: string) => !only || only.split(',').includes(k);
  log(`engine stress test (${typeof HermesInternal !== 'undefined' ? 'Hermes' : 'Node'})`);
  if (want('txt')) await measure('TXT English, hard-wrapped', 'en.txt', makeEnglishTxt(100));
  if (want('txt1251')) await measure('TXT Russian windows-1251', 'ru.txt', makeRussianTxt(50));
  if (want('epub')) {
    const giant = { data: base64ToBytes(BENCH_FIXTURE.chapterB64), size: BENCH_FIXTURE.chapterSize };
    await measure('EPUB 40MB chapter+300ch+300 imgs', 'big.epub', makeEpub(giant, 300, 300, 1));
  }
  if (want('fb2')) await measure('FB2 UTF-8 + 40 big images', 'big.fb2', makeFb2(50, 40, 1));
  if (want('mobi')) await measure('MOBI PalmDOC + 20 images', 'big.mobi', makeMobi(30, 20));
  // (Last, so the books above are generated from the same random numbers as before it was added.)
  if (want('txt1254')) await measure('TXT Turkish windows-1254, wrapped', 'tr.txt', makeTurkishTxt(30));
}
