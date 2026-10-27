// Streaming text decoders. Books arrive in whatever encoding the author's
// tool produced (lots of FB2/TXT files are still windows-1251, Turkish ones
// windows-1254), and we decode them a slice at a time so a huge file never
// has to sit in memory as one string.

import { concatBytes } from './io';

export type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1251' | 'windows-1252' | 'windows-1254' | 'koi8-r';

export interface StreamDecoder {
  /** Decode the next slice. Incomplete multi-byte sequences are carried over. */
  decode(bytes: Uint8Array): string;
  /** Flush anything still buffered. */
  end(): string;
}

// Characters for bytes 0x80..0xFF, 4 hex digits each.
const TABLES: Record<string, string> = {
  'windows-1251':
    '04020403201a0453201e20262020202120ac203004092039040a040c040b040f045220182019201c201d202220132014fffd21220459203a045a045c045b045f00a0040e045e040800a4049000a600a7040100a9040400ab00ac00ad00ae040700b000b104060456049100b500b600b704512116045400bb04580405045504570410041104120413041404150416041704180419041a041b041c041d041e041f0420042104220423042404250426042704280429042a042b042c042d042e042f0430043104320433043404350436043704380439043a043b043c043d043e043f0440044104420443044404450446044704480449044a044b044c044d044e044f',
  'windows-1252':
    '20acfffd201a0192201e20262020202102c62030016020390152fffd017dfffdfffd20182019201c201d20222013201402dc21220161203a0153fffd017e017800a000a100a200a300a400a500a600a700a800a900aa00ab00ac00ad00ae00af00b000b100b200b300b400b500b600b700b800b900ba00bb00bc00bd00be00bf00c000c100c200c300c400c500c600c700c800c900ca00cb00cc00cd00ce00cf00d000d100d200d300d400d500d600d700d800d900da00db00dc00dd00de00df00e000e100e200e300e400e500e600e700e800e900ea00eb00ec00ed00ee00ef00f000f100f200f300f400f500f600f700f800f900fa00fb00fc00fd00fe00ff',
  // Turkish. ISO-8859-9 is the same outside 0x80..0x9F, which it leaves to control characters.
  'windows-1254':
    '20acfffd201a0192201e20262020202102c62030016020390152fffdfffdfffdfffd20182019201c201d20222013201402dc21220161203a0153fffdfffd017800a000a100a200a300a400a500a600a700a800a900aa00ab00ac00ad00ae00af00b000b100b200b300b400b500b600b700b800b900ba00bb00bc00bd00be00bf00c000c100c200c300c400c500c600c700c800c900ca00cb00cc00cd00ce00cf011e00d100d200d300d400d500d600d700d800d900da00db00dc0130015e00df00e000e100e200e300e400e500e600e700e800e900ea00eb00ec00ed00ee00ef011f00f100f200f300f400f500f600f700f800f900fa00fb00fc0131015f00ff',
  'koi8-r':
    '25002502250c251025142518251c2524252c2534253c258025842588258c2590259125922593232025a02219221a22482264226500a0232100b000b200b700f725502551255204512553255425552556255725582559255a255b255c255d255e255f25602561040125622563256425652566256725682569256a256b256c00a9044e0430043104460434043504440433044504380439043a043b043c043d043e043f044f044004410442044304360432044c044b04370448044d04490447044a042e0410041104260414041504240413042504180419041a041b041c041d041e041f042f042004210422042304160412042c042b04170428042d04290427042a',
};

const parsedTables: Record<string, Uint16Array> = {};

function table(enc: string): Uint16Array {
  let t = parsedTables[enc];
  if (!t) {
    const hex = TABLES[enc];
    t = new Uint16Array(256);
    for (let i = 0; i < 128; i++) t[i] = i;
    for (let i = 0; i < 128; i++) t[128 + i] = parseInt(hex.slice(i * 4, i * 4 + 4), 16);
    parsedTables[enc] = t;
  }
  return t;
}

const CHUNK = 8192;

function codesToString(codes: Uint16Array, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += CHUNK) {
    out += String.fromCharCode.apply(null, codes.subarray(i, Math.min(length, i + CHUNK)) as unknown as number[]);
  }
  return out;
}

class SingleByteDecoder implements StreamDecoder {
  private t: Uint16Array;
  constructor(enc: string) {
    this.t = table(enc);
  }
  decode(bytes: Uint8Array): string {
    const t = this.t;
    const codes = new Uint16Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) codes[i] = t[bytes[i]];
    return codesToString(codes, codes.length);
  }
  end() {
    return '';
  }
}

export class Utf8Decoder implements StreamDecoder {
  private carry: Uint8Array | null = null;

  decode(input: Uint8Array): string {
    let bytes = input;
    if (this.carry) {
      bytes = new Uint8Array(this.carry.length + input.length);
      bytes.set(this.carry);
      bytes.set(input, this.carry.length);
      this.carry = null;
    }
    // Leave a trailing incomplete sequence for the next call.
    let end = bytes.length;
    for (let back = 1; back <= 3 && end - back >= 0; back++) {
      const b = bytes[end - back];
      if ((b & 0xc0) !== 0x80) {
        const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
        if (need > back) {
          this.carry = bytes.slice(end - back);
          end -= back;
        }
        break;
      }
    }
    return decodeUtf8(bytes, 0, end);
  }

  end(): string {
    const c = this.carry;
    this.carry = null;
    return c ? decodeUtf8(c, 0, c.length) : '';
  }
}

/**
 * UTF-8 as browsers decode it: a broken sequence becomes one U+FFFD and the
 * byte that broke it starts afresh, so a stray byte never swallows the
 * letter after it.
 */
export function decodeUtf8(bytes: Uint8Array, start = 0, end = bytes.length): string {
  const codes = new Uint16Array(end - start);
  let n = 0;
  let i = start;
  // (Shaped for Hermes, which has no JIT: the usual characters take one test each.)
  while (i < end) {
    const b = bytes[i++];
    if (b < 0x80) codes[n++] = b;
    else if (b >= 0xc2 && b < 0xe0 && i < end && (bytes[i] & 0xc0) === 0x80) codes[n++] = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else if (
      b >= 0xe0 &&
      b < 0xf0 &&
      i + 1 < end &&
      (bytes[i] & 0xc0) === 0x80 &&
      (bytes[i + 1] & 0xc0) === 0x80 &&
      (b !== 0xe0 || bytes[i] >= 0xa0) &&
      (b !== 0xed || bytes[i] < 0xa0) // no surrogates
    ) {
      codes[n++] = ((b & 0x0f) << 12) | ((bytes[i] & 0x3f) << 6) | (bytes[i + 1] & 0x3f);
      i += 2;
    } else if (b >= 0xf0 && b < 0xf5) {
      // Four bytes, or as many as are well-formed before one breaks the sequence.
      const lo = b === 0xf0 ? 0x90 : 0x80;
      const hi = b === 0xf4 ? 0x8f : 0xbf;
      if (i < end && bytes[i] >= lo && bytes[i] <= hi) {
        if (i + 1 < end && (bytes[i + 1] & 0xc0) === 0x80) {
          if (i + 2 < end && (bytes[i + 2] & 0xc0) === 0x80) {
            const cp = (((b & 0x07) << 18) | ((bytes[i] & 0x3f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)) - 0x10000;
            codes[n++] = 0xd800 + (cp >> 10);
            codes[n++] = 0xdc00 + (cp & 0x3ff);
            i += 3;
          } else {
            codes[n++] = 0xfffd;
            i += 2;
          }
        } else {
          codes[n++] = 0xfffd;
          i++;
        }
      } else codes[n++] = 0xfffd;
    } else {
      // A broken two- or three-byte sequence: one U+FFFD for the bytes that fit, then start afresh.
      if (b >= 0xe0 && b < 0xf0 && i < end && bytes[i] >= (b === 0xe0 ? 0xa0 : 0x80) && bytes[i] <= (b === 0xed ? 0x9f : 0xbf)) i++;
      codes[n++] = 0xfffd;
    }
  }
  return codesToString(codes, n);
}

class Utf16Decoder implements StreamDecoder {
  private carry = -1;
  constructor(private le: boolean) {}
  decode(input: Uint8Array): string {
    let bytes = input;
    if (this.carry >= 0) {
      bytes = new Uint8Array(input.length + 1);
      bytes[0] = this.carry;
      bytes.set(input, 1);
      this.carry = -1;
    }
    const pairs = bytes.length >> 1;
    if (bytes.length & 1) this.carry = bytes[bytes.length - 1];
    const codes = new Uint16Array(pairs);
    for (let i = 0; i < pairs; i++) {
      const a = bytes[i * 2];
      const b = bytes[i * 2 + 1];
      codes[i] = this.le ? a | (b << 8) : (a << 8) | b;
    }
    return codesToString(codes, pairs);
  }
  end() {
    return '';
  }
}

/** Wrap the platform TextDecoder when it supports the encoding; it's much faster. */
class NativeDecoder implements StreamDecoder {
  constructor(private d: TextDecoder) {}
  decode(bytes: Uint8Array) {
    return this.d.decode(bytes, { stream: true });
  }
  end() {
    return this.d.decode();
  }
}

export function createDecoder(enc: Encoding, allowNative = true): StreamDecoder {
  if (allowNative && enc === 'utf-8' && typeof TextDecoder !== 'undefined') {
    try {
      // Make sure streaming works: a split euro sign must come out whole.
      const probe = new TextDecoder('utf-8');
      const ok = probe.decode(new Uint8Array([0xe2, 0x82]), { stream: true }) + probe.decode(new Uint8Array([0xac])) === '\u20ac';
      if (ok) return new NativeDecoder(new TextDecoder('utf-8'));
    } catch {
      // fall through to the JS decoder
    }
  }
  switch (enc) {
    case 'utf-8':
      return new Utf8Decoder();
    case 'utf-16le':
      return new Utf16Decoder(true);
    case 'utf-16be':
      return new Utf16Decoder(false);
    default:
      return new SingleByteDecoder(enc);
  }
}

// Encoding names as files write them, with everything but letters and digits
// left out ("ISO_8859-9" -> "iso88599"): the labels browsers accept. (A Map:
// encoding="constructor" is an unknown label, not something every object has.)
const LABELS = new Map<string, Encoding>();
for (const [enc, names] of [
  ['utf-8', 'utf8 unicode11utf8 unicode20utf8 xunicode20utf8'],
  ['utf-16le', 'utf16 utf16le unicode ucs2 iso10646ucs2 csunicode unicodefeff'],
  ['utf-16be', 'utf16be unicodefffe'],
  ['windows-1251', 'windows1251 cp1251 xcp1251 win1251'],
  ['windows-1252', 'windows1252 cp1252 xcp1252 win1252 iso88591 iso885911987 latin1 l1 usascii ascii ansix341968 cp819 ibm819 csisolatin1 isoir100'],
  ['windows-1254', 'windows1254 cp1254 xcp1254 win1254 iso88599 iso885991989 latin5 l5 isoir148 csisolatin5'],
  ['koi8-r', 'koi8r koi8 koi cskoi8r koi8u koi8ru'],
] as const) {
  for (const n of names.split(' ')) LABELS.set(n, enc);
}

/** The encoding an encoding label names; null if it isn't one we know. */
export function normalizeEncoding(label: string | null | undefined): Encoding | null {
  if (!label) return null;
  return LABELS.get(label.toLowerCase().replace(/[^a-z0-9]/g, '')) ?? null;
}

export function detectBom(bytes: Uint8Array): { enc: Encoding; skip: number } | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { enc: 'utf-8', skip: 3 };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { enc: 'utf-16le', skip: 2 };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { enc: 'utf-16be', skip: 2 };
  return null;
}

/** What a sample of bytes looks like, for guessing its encoding. */
interface ByteStats {
  bytes: number;
  /** Bytes 0x80 and up. */
  high: number;
  /** ASCII letters. */
  latin: number;
  /** High bytes in runs of three or more: Cyrillic words in a one-byte encoding. */
  runs: number;
  /** Well-formed UTF-8 multi-byte sequences, and bytes that can't be UTF-8. */
  utf8: number;
  bad: number;
  zeroEven: number;
  zeroOdd: number;
  counts: Uint32Array;
}

function newStats(): ByteStats {
  return { bytes: 0, high: 0, latin: 0, runs: 0, utf8: 0, bad: 0, zeroEven: 0, zeroOdd: 0, counts: new Uint32Array(256) };
}

/**
 * Add a sample to the stats, in one pass (this runs over a few hundred KB
 * before a book can start converting). One cut from the middle of a file
 * (`mid`) may start inside a UTF-8 sequence; any sample may end inside one.
 * Neither counts as bad.
 */
function addSample(s: ByteStats, bytes: Uint8Array, mid = false) {
  const n = bytes.length;
  const counts = s.counts;
  let i = 0;
  if (mid) while (i < n && i < 3 && (bytes[i] & 0xc0) === 0x80) i++;
  if (!s.bytes) {
    for (let j = 0; j < Math.min(n, 4096); j++) {
      if (bytes[j] !== 0) continue;
      if (j & 1) s.zeroOdd++;
      else s.zeroEven++;
    }
  }
  s.bytes += n - i;
  let run = 0;
  // UTF-8: continuation bytes still needed, and the range the next one must be in.
  let need = 0;
  let lo = 0x80;
  let hi = 0xbf;
  for (; i < n; i++) {
    const b = bytes[i];
    if (need) {
      if (b >= lo && b <= hi) {
        lo = 0x80;
        hi = 0xbf;
        if (--need === 0) s.utf8++;
        s.high++;
        counts[b]++;
        run++;
        continue;
      }
      // Broken off: this byte starts afresh.
      s.bad++;
      need = 0;
      lo = 0x80;
      hi = 0xbf;
    }
    if (b < 0x80) {
      if (run >= 3) s.runs += run;
      run = 0;
      if (((b | 32) - 97) >>> 0 < 26) s.latin++;
      continue;
    }
    s.high++;
    counts[b]++;
    run++;
    if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      if (b === 0xe0) lo = 0xa0;
      else if (b === 0xed) hi = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      if (b === 0xf0) lo = 0x90;
      else if (b === 0xf4) hi = 0x8f;
    } else s.bad++;
  }
  if (run >= 3) s.runs += run;
}

/**
 * Plausibly UTF-8: no bytes that can't be, or so few next to the well-formed
 * multi-byte characters that they're damage (a stray byte pasted in) rather
 * than another encoding. In a one-byte encoding nearly every accented letter
 * is followed by a plain one, which UTF-8 can't have, so there the bad bytes
 * far outnumber the accidental well-formed sequences.
 */
function isUtf8(s: ByteStats): boolean {
  return s.bad === 0 || s.bad * 8 <= s.utf8;
}

/** Clearly UTF-8 whatever a declaration says (files saved as UTF-8 but labelled Latin-1 are common). */
function surelyUtf8(s: ByteStats): boolean {
  return s.utf8 >= 4 && s.bad * 8 <= s.utf8;
}

/** In windows-1254 these bytes are ğ Ğ ı İ ş Ş; in windows-1252 the rarely used ð Ð ý Ý þ Þ. */
function looksTurkish(s: ByteStats): boolean {
  const c = s.counts;
  const tr = c[0xd0] + c[0xdd] + c[0xde] + c[0xf0] + c[0xfd] + c[0xfe];
  // Icelandic (the other language using ð ý þ) also has plenty of æ á ó ú, which Turkish never uses.
  const icelandic = c[0xe6] + c[0xe1] + c[0xf3] + c[0xfa];
  return tr >= 3 && tr > s.high * 0.2 && icelandic < s.high * 0.1;
}

function singleByte(s: ByteStats): Encoding {
  const c = s.counts;
  // Cyrillic text in a one-byte encoding: most letters are high bytes, and
  // they come in whole words. Turkish or French text has a high byte here
  // and there among plain letters.
  const share = s.high / Math.max(1, s.high + s.latin);
  if (share > 0.4 || (share > 0.15 && s.runs > s.high * 0.5)) {
    // Lower case is more common: 0xE0..0xFF in windows-1251, 0xC0..0xDF in koi8-r.
    let upperHalf = 0;
    let lowerHalf = 0;
    for (let b = 0xc0; b < 0xe0; b++) lowerHalf += c[b];
    for (let b = 0xe0; b <= 0xff; b++) upperHalf += c[b];
    return upperHalf >= lowerHalf ? 'windows-1251' : 'koi8-r';
  }
  return looksTurkish(s) ? 'windows-1254' : 'windows-1252';
}

function utf16(s: ByteStats): Encoding | null {
  // UTF-16 without BOM: lots of zero bytes in alternating positions.
  const lim = Math.min(s.bytes, 4096);
  if (s.zeroOdd > lim / 4 && s.zeroEven < lim / 50) return 'utf-16le';
  if (s.zeroEven > lim / 4 && s.zeroOdd < lim / 50) return 'utf-16be';
  return null;
}

function guess(s: ByteStats): Encoding {
  return utf16(s) ?? (isUtf8(s) ? 'utf-8' : singleByte(s));
}

/** Plausible UTF-8 throughout (a sequence cut off at the very end is allowed). */
export function looksLikeUtf8(bytes: Uint8Array): boolean {
  const s = newStats();
  addSample(s, bytes);
  return s.bad === 0;
}

/**
 * Best guess for plain text without a BOM, from its start and, for a big
 * file, samples from further in (a file can open with pages of plain ASCII).
 */
export function sniffEncoding(sample: Uint8Array, more: Uint8Array[] = []): Encoding {
  const bom = detectBom(sample);
  if (bom) return bom.enc;
  const s = newStats();
  addSample(s, sample);
  for (const m of more) addSample(s, m, true);
  return guess(s);
}

/** Latin-1 view of the first bytes, for reading declarations (zero bytes of UTF-16 dropped). */
function asciiHead(head: Uint8Array, n: number): string {
  const s = String.fromCharCode.apply(null, head.subarray(0, n) as unknown as number[]);
  return s.indexOf('\0') >= 0 ? s.split('\0').join('') : s;
}

/** The encoding labels markup declares near its start: `<?xml encoding>`, and an HTML `<meta charset>`. */
export function declaredEncodings(head: Uint8Array): { xml: string | null; meta: string | null } {
  const s = asciiHead(head, 2048);
  const xml = /^\s*<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/.exec(s);
  const meta = /<meta\b[^>]*?charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/i.exec(s);
  return { xml: xml ? xml[1] : null, meta: meta ? meta[1] : null };
}

const wide = (e: Encoding | null) => e === 'utf-16le' || e === 'utf-16be';

/**
 * Plainly not UTF-8: many bytes that can't be UTF-8, and far more of them
 * than well-formed characters. A stray byte or two in UTF-8 text (a "©"
 * pasted in) doesn't count: they become U+FFFD, and the rest reads right.
 * In a one-byte encoding nearly every accented letter is such a byte.
 * `whole`: the sample is all the rest of the file, so a few are enough.
 */
function plainlyNotUtf8(s: ByteStats, whole: boolean): boolean {
  return s.bad > s.utf8 * 8 && (s.bad >= 16 || (whole && s.bad >= 3 && s.utf8 === 0));
}

/**
 * The encoding of an XML or HTML file, from what it declares and a sample
 * of its bytes from the first one above ASCII on. A one-byte encoding its
 * XML declaration names holds unless the bytes are plainly UTF-8 (Turkish
 * labelled Latin-1 is read as Turkish). Otherwise it's UTF-8, as XML has it,
 * unless the bytes are plainly not; then a <meta charset> (which XHTML
 * doesn't go by) or a guess from the bytes says which one-byte encoding.
 */
function markupChoice(xml: Encoding | null, meta: Encoding | null, s: ByteStats, whole: boolean): Encoding {
  const turkish = (e: Encoding): Encoding => (e === 'windows-1252' && looksTurkish(s) ? 'windows-1254' : e);
  if (xml && xml !== 'utf-8' && !wide(xml)) return surelyUtf8(s) ? 'utf-8' : turkish(xml);
  if (!plainlyNotUtf8(s, whole)) return 'utf-8';
  return meta && meta !== 'utf-8' && !wide(meta) ? turkish(meta) : singleByte(s);
}

const HIGH = /[\x80-\xff]/;

/**
 * Where the first byte above ASCII is (the length if there's none), and the
 * ASCII before it as text: a Latin-1 view of the bytes, made natively, searched.
 */
function asciiPrefix(bytes: Uint8Array): { at: number; text: string } {
  let text = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const part = String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + CHUNK)) as unknown as number[]);
    const k = part.search(HIGH);
    if (k >= 0) return { at: i + k, text: text + part.slice(0, k) };
    text += part;
  }
  return { at: bytes.length, text };
}

export class MarkupDecoder implements StreamDecoder {
  /** Bytes held back: the first ones, until the declarations can be read; then the sample being judged. */
  private held: Uint8Array[] = [];
  private heldBytes = 0;
  private started = false;
  private judging = false;
  private xml: Encoding | null = null;
  private meta: Encoding | null = null;
  private d: StreamDecoder | null = null;
  /** The encoding chosen, once it has been. */
  encoding: Encoding | null = null;

  /** `probe`: how many bytes from the first one above ASCII the choice is made on. */
  constructor(private probe = 16 * 1024) {}

  decode(bytes: Uint8Array): string {
    if (this.d) return this.d.decode(bytes);
    if (!this.started) {
      this.hold(bytes);
      return this.heldBytes >= 2048 ? this.start() : '';
    }
    if (this.judging) {
      this.hold(bytes);
      return this.heldBytes >= this.probe ? this.judge(false) : '';
    }
    return this.ascii(bytes);
  }

  end(): string {
    let s = this.started ? '' : this.start();
    if (!this.d) s += this.judge(true);
    return s + this.d!.end();
  }

  private hold(bytes: Uint8Array) {
    this.held.push(bytes);
    this.heldBytes += bytes.length;
  }

  private take(): Uint8Array {
    const all = this.held.length === 1 ? this.held[0] : concatBytes(this.held, this.heldBytes);
    this.held = [];
    this.heldBytes = 0;
    return all;
  }

  private use(enc: Encoding, bytes: Uint8Array): string {
    this.encoding = enc;
    this.d = createDecoder(enc);
    return this.d.decode(bytes);
  }

  private start(): string {
    this.started = true;
    const all = this.take();
    const bom = detectBom(all);
    if (bom) return this.use(bom.enc, all.subarray(bom.skip));
    // UTF-16 without a BOM: markup starts with "<" or a space, so one of the first two bytes is zero.
    if (all[0] === 0 || all[1] === 0) {
      const s = newStats();
      addSample(s, all.subarray(0, 4096));
      const utf16Enc = utf16(s);
      if (utf16Enc) return this.use(utf16Enc, all);
    }
    const labels = declaredEncodings(all);
    this.xml = normalizeEncoding(labels.xml);
    this.meta = normalizeEncoding(labels.meta);
    return this.ascii(all);
  }

  /** ASCII passes through; from the first byte above it, the bytes are held to choose the encoding by. */
  private ascii(bytes: Uint8Array): string {
    const { at, text } = asciiPrefix(bytes);
    if (at === bytes.length) return text;
    this.judging = true;
    this.hold(bytes.subarray(at));
    return text + (this.heldBytes >= this.probe ? this.judge(false) : '');
  }

  private judge(whole: boolean): string {
    const sample = this.take();
    if (!this.xml || this.xml === 'utf-8' || wide(this.xml)) {
      // Nearly always: UTF-8, read as such without a hitch. Only damage calls for a closer look.
      const d = createDecoder('utf-8');
      const text = d.decode(sample);
      if (text.indexOf('\ufffd') < 0) {
        this.encoding = 'utf-8';
        this.d = d;
        return text;
      }
      const s = newStats();
      addSample(s, sample);
      const enc = markupChoice(this.xml, this.meta, s, whole);
      if (enc === 'utf-8') {
        this.encoding = enc;
        this.d = d;
        return text;
      }
      return this.use(enc, sample);
    }
    const s = newStats();
    addSample(s, sample);
    return this.use(markupChoice(this.xml, this.meta, s, whole), sample);
  }
}

/** A whole small XML or HTML file (package, contents, stylesheet) as text. */
export function decodeMarkup(bytes: Uint8Array): string {
  const d = new MarkupDecoder(Infinity);
  return d.decode(bytes) + d.end();
}
