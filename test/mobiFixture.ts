// Builds MOBI (KF7) and AZW3 (KF8) files for tests, following the Palm
// database / Mobipocket layout byte for byte. Generated KF7 files are also
// checked with KindleUnpack (see bench/README or the test notes).

const enc = new TextEncoder();

function u16(n: number) {
  return [(n >> 8) & 255, n & 255];
}
function u32(n: number) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

/** PalmDOC compression: literals, escaped byte runs, space+char pairs and back-references. */
export function palmdocCompress(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < input.length) {
    // Longest earlier match (3..10 bytes, up to 2047 back).
    let bestLen = 0;
    let bestDist = 0;
    if (i + 3 <= input.length) {
      for (let d = 1; d <= Math.min(2047, i); d++) {
        let l = 0;
        while (l < 10 && i + l < input.length && input[i + l] === input[i - d + l]) l++;
        if (l > bestLen) {
          bestLen = l;
          bestDist = d;
          if (l === 10) break;
        }
      }
    }
    if (bestLen >= 3) {
      const pair = 0x8000 | (bestDist << 3) | (bestLen - 3);
      out.push(pair >> 8, pair & 255);
      i += bestLen;
      continue;
    }
    const c = input[i];
    const next = input[i + 1];
    if (c === 0x20 && next !== undefined && next >= 0x40 && next <= 0x7f) {
      out.push(next ^ 0x80);
      i += 2;
    } else if (c === 0 || (c >= 9 && c <= 0x7f)) {
      out.push(c);
      i++;
    } else {
      // Escape up to 8 bytes that can't be literals.
      let n = 1;
      while (n < 8 && i + n < input.length && !(input[i + n] === 0 || (input[i + n] >= 9 && input[i + n] <= 0x7f))) n++;
      out.push(n, ...input.subarray(i, i + n));
      i += n;
    }
  }
  return Uint8Array.from(out);
}

interface Options {
  html: string;
  title: string;
  author?: string;
  lang?: string;
  images?: Uint8Array[];
  /** EXTH cover offset (index into images). */
  cover?: number;
  kf8?: boolean;
  /** For KF8: text after the HTML that belongs to another flow (CSS). */
  extraFlow?: string;
  compression?: 1 | 2;
  /** Add multibyte + TBS trailing entries to each text record. */
  trailing?: boolean;
  encryption?: number;
}

/** Split UTF-8 bytes into ~4096-byte records without cutting a character. */
function splitRecords(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let p = 0;
  while (p < bytes.length) {
    let end = Math.min(bytes.length, p + 4096);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push(bytes.subarray(p, end));
    p = end;
  }
  return out;
}

export function buildMobi(o: Options): Uint8Array {
  const compression = o.compression ?? 2;
  const htmlBytes = enc.encode(o.html);
  const textBytes = o.extraFlow ? Uint8Array.from([...htmlBytes, ...enc.encode(o.extraFlow)]) : htmlBytes;
  // Identical records (big generated books repeat text) are compressed once.
  const packed = new Map<string, Uint8Array>();
  const compress = (r: Uint8Array) => {
    const key = String.fromCharCode.apply(null, Array.from(r));
    let c = packed.get(key);
    if (!c) packed.set(key, (c = palmdocCompress(r)));
    return c;
  };
  const textRecs = splitRecords(textBytes).map((r) => {
    const body = compression === 2 ? compress(r) : r;
    // Trailing data: a multibyte-overlap byte (flag 1) then a 1-byte TBS entry (flag 2).
    return o.trailing ? Uint8Array.from([...body, 0x00, 0x81]) : body;
  });
  const images = o.images ?? [];
  const firstImage = images.length ? textRecs.length + 1 : 0xffffffff;
  const fdstIndex = textRecs.length + 1 + images.length;

  const title = enc.encode(o.title);
  const exth: number[][] = [];
  const addExth = (type: number, data: number[]) => exth.push([...u32(type), ...u32(data.length + 8), ...data]);
  if (o.author) addExth(100, [...enc.encode(o.author)]);
  if (o.lang) addExth(524, [...enc.encode(o.lang)]);
  if (o.cover !== undefined) addExth(201, u32(o.cover));
  addExth(503, [...title]);
  const exthBody = exth.flat();
  const exthLen = 12 + exthBody.length;
  const exthPad = (4 - (exthLen % 4)) % 4;
  const exthBlock = [...enc.encode('EXTH'), ...u32(exthLen + exthPad), ...u32(exth.length), ...exthBody, ...new Array(exthPad).fill(0)];

  const headerLength = 232;
  const nameOffset = 16 + headerLength + exthBlock.length;
  const mobi = new Array(headerLength).fill(0);
  const put = (off: number, bytes: number[]) => bytes.forEach((b, k) => (mobi[off - 16 + k] = b));
  put(16, [...enc.encode('MOBI')]);
  put(20, u32(headerLength));
  put(24, u32(2));
  put(28, u32(65001));
  put(32, u32(0x12345678));
  put(36, u32(o.kf8 ? 8 : 6));
  for (let off = 40; off < 80; off += 4) put(off, u32(0xffffffff));
  put(80, u32(textRecs.length + 1));
  put(84, u32(nameOffset));
  put(88, u32(title.length));
  put(92, u32(9));
  put(104, u32(o.kf8 ? 8 : 6));
  put(108, u32(firstImage));
  put(128, u32(0x50));
  put(164, u32(0xffffffff));
  put(192, o.kf8 ? u32(fdstIndex) : [...u16(1), ...u16(textRecs.length)]);
  put(196, u32(1));
  put(240, u32(o.trailing ? 3 : 0));
  put(244, u32(0xffffffff));

  const palmdoc = [...u16(compression), 0, 0, ...u32(textBytes.length), ...u16(textRecs.length), ...u16(4096), ...u16(o.encryption ?? 0), 0, 0];
  const rec0 = Uint8Array.from([...palmdoc, ...mobi, ...exthBlock, ...title, 0, 0, 0, 0]);

  const records: Uint8Array[] = [rec0, ...textRecs, ...images];
  if (o.kf8) {
    const htmlLen = htmlBytes.length;
    const total = textBytes.length;
    const sections = o.extraFlow ? [0, htmlLen, htmlLen, total] : [0, total];
    records.push(Uint8Array.from([...enc.encode('FDST'), ...u32(12), ...u32(sections.length / 2), ...sections.flatMap(u32)]));
  }
  records.push(Uint8Array.from([0xe9, 0x8e, 0x0d, 0x0a])); // EOF record

  // Palm database header + record list.
  const pdbHeader = new Array(78).fill(0);
  const name = enc.encode(o.title.replace(/[^A-Za-z0-9]/g, '_').slice(0, 31));
  name.forEach((b, k) => (pdbHeader[k] = b));
  enc.encode('BOOKMOBI').forEach((b, k) => (pdbHeader[60 + k] = b));
  u16(records.length).forEach((b, k) => (pdbHeader[76 + k] = b));
  const listLen = records.length * 8 + 2;
  let offset = 78 + listLen;
  const list: number[] = [];
  records.forEach((r, k) => {
    list.push(...u32(offset), 0, ...[(2 * k) >> 16, ((2 * k) >> 8) & 255, (2 * k) & 255]);
    offset += r.length;
  });
  list.push(0, 0);
  const out = new Uint8Array(offset);
  out.set(pdbHeader, 0);
  out.set(list, 78);
  let p = 78 + listLen;
  for (const r of records) {
    out.set(r, p);
    p += r.length;
  }
  return out;
}

/** A tiny but real JPEG header so image sniffing recognises it. */
export function fakeJpeg(seed: number) {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, seed & 255, 0, 0, 0xff, 0xd9]);
}
