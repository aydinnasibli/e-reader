// Streaming text decoders. Books arrive in whatever encoding the author's
// tool produced (lots of FB2/TXT files are still windows-1251), and we decode
// them a slice at a time so a huge file never has to sit in memory as one string.

export type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1251' | 'windows-1252' | 'koi8-r';

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

export function decodeUtf8(bytes: Uint8Array, start = 0, end = bytes.length): string {
  const codes = new Uint16Array(end - start);
  let n = 0;
  let i = start;
  while (i < end) {
    const b = bytes[i++];
    if (b < 0x80) {
      codes[n++] = b;
    } else if (b >= 0xc2 && b < 0xe0 && i < end) {
      codes[n++] = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
    } else if (b >= 0xe0 && b < 0xf0 && i + 1 < end) {
      codes[n++] = ((b & 0x0f) << 12) | ((bytes[i] & 0x3f) << 6) | (bytes[i + 1] & 0x3f);
      i += 2;
    } else if (b >= 0xf0 && b < 0xf5 && i + 2 < end) {
      let cp = ((b & 0x07) << 18) | ((bytes[i] & 0x3f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
      i += 3;
      cp -= 0x10000;
      codes[n++] = 0xd800 + (cp >> 10);
      codes[n++] = 0xdc00 + (cp & 0x3ff);
    } else {
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

export function normalizeEncoding(label: string | null | undefined): Encoding | null {
  if (!label) return null;
  const l = label.trim().toLowerCase().replace(/_/g, '-');
  if (l === 'utf-8' || l === 'utf8') return 'utf-8';
  if (l === 'utf-16' || l === 'utf-16le') return 'utf-16le';
  if (l === 'utf-16be') return 'utf-16be';
  if (l === 'windows-1251' || l === 'cp1251' || l === 'win-1251') return 'windows-1251';
  if (l === 'windows-1252' || l === 'cp1252' || l === 'iso-8859-1' || l === 'latin1' || l === 'us-ascii' || l === 'ascii')
    return 'windows-1252';
  if (l === 'koi8-r' || l === 'koi8r' || l === 'koi8-u') return 'koi8-r';
  return null;
}

export function detectBom(bytes: Uint8Array): { enc: Encoding; skip: number } | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { enc: 'utf-8', skip: 3 };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { enc: 'utf-16le', skip: 2 };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { enc: 'utf-16be', skip: 2 };
  return null;
}

/** True if the sample is plausible UTF-8 (a cut-off sequence at the very end is allowed). */
export function looksLikeUtf8(bytes: Uint8Array): boolean {
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i];
    if (b < 0x80) {
      i++;
      continue;
    }
    const need = b >= 0xc2 && b < 0xe0 ? 1 : b >= 0xe0 && b < 0xf0 ? 2 : b >= 0xf0 && b < 0xf5 ? 3 : -1;
    if (need < 0) return false;
    for (let k = 1; k <= need; k++) {
      if (i + k >= n) return true;
      if ((bytes[i + k] & 0xc0) !== 0x80) return false;
    }
    i += need + 1;
  }
  return true;
}

/** Best guess for a plain-text sample without a BOM. */
export function sniffEncoding(sample: Uint8Array): Encoding {
  const bom = detectBom(sample);
  if (bom) return bom.enc;
  // UTF-16 without BOM: lots of zero bytes in alternating positions.
  let zEven = 0;
  let zOdd = 0;
  const lim = Math.min(sample.length, 4096);
  for (let i = 0; i < lim; i++) {
    if (sample[i] !== 0) continue;
    if (i & 1) zOdd++;
    else zEven++;
  }
  if (zOdd > lim / 4 && zEven < lim / 50) return 'utf-16le';
  if (zEven > lim / 4 && zOdd < lim / 50) return 'utf-16be';
  if (looksLikeUtf8(sample)) return 'utf-8';
  let high = 0;
  let upperHalf = 0; // 0xE0..0xFF: lowercase in cp1251, uppercase in koi8-r
  let lowerHalf = 0; // 0xC0..0xDF: the opposite
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b >= 0x80) high++;
    if (b >= 0xe0) upperHalf++;
    else if (b >= 0xc0) lowerHalf++;
  }
  if (high > sample.length * 0.25) return upperHalf >= lowerHalf ? 'windows-1251' : 'koi8-r';
  return 'windows-1252';
}

/** Read `encoding="..."` from an XML declaration at the start of the bytes. */
export function xmlDeclaredEncoding(head: Uint8Array): Encoding | null {
  let s = '';
  for (let i = 0; i < Math.min(head.length, 300); i++) s += String.fromCharCode(head[i]);
  const m = /^\s*<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/.exec(s.replace(/\0/g, ''));
  return m ? normalizeEncoding(m[1]) : null;
}
