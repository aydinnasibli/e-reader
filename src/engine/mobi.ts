// Kindle formats: MOBI (Mobipocket / KF7) and AZW3 (KF8), both stored in a
// Palm database. Text records are decompressed one at a time (PalmDOC LZ77)
// and streamed through the same HTML converter as EPUB chapters; images stay
// in the file and are read when shown.
//
// Combined .mobi files (KF7 + KF8 sections) are read from their KF7 part,
// which holds the full text in plain HTML. Standalone AZW3 files store KF8
// "skeleton + fragments" text whose raw order is reading order, so it can be
// streamed the same way. DRM-protected and HUFF/CDIC-compressed books are
// reported as unsupported.

import { be16, be32 } from './bytes';
import { createDecoder } from './decode';
import { HtmlToBlocks } from './html';
import { BookError, type ByteSource, CUT_SHORT, DRM_MESSAGE, type IngestContext } from './io';
import { bookLanguage } from './language';
import { MarkupTokenizer } from './markup';
import { ENGINE_VERSION, type ImageRef, type Manifest } from './types';
import { PictureProbe } from './picture';
import { BookWriter, cleanText } from './writer';

const NO_INDEX = 0xffffffff;

export class MobiError extends BookError {}

interface Pdb {
  /** Start offset of each record, plus the file size as a final entry. */
  offsets: number[];
  type: string;
  creator: string;
}

function readPdb(src: ByteSource): Pdb {
  const head = src.read(0, 78);
  if (head.length < 78) throw new MobiError(CUT_SHORT);
  const type = String.fromCharCode(...head.subarray(60, 64));
  const creator = String.fromCharCode(...head.subarray(64, 68));
  const count = be16(head, 76);
  const list = src.read(78, count * 8);
  if (list.length < count * 8) throw new MobiError(CUT_SHORT);
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(be32(list, i * 8));
  offsets.push(src.size);
  return { offsets, type, creator };
}

export function isMobi(src: ByteSource): boolean {
  // (Even cut short before its list of records: then it's told it's damaged.)
  if (src.size < 68) return false;
  const head = src.read(60, 8);
  const tc = String.fromCharCode(...head);
  return tc === 'BOOKMOBI' || tc === 'TEXtREAd';
}

interface Header {
  /** Record index of this header (0, or the KF8 boundary). */
  base: number;
  compression: number;
  textLength: number;
  textRecords: number;
  encryption: number;
  encoding: number;
  /** Mobipocket header version; 0 for plain PalmDOC text (no MOBI header). */
  version: number;
  firstImage: number;
  extraFlags: number;
  /** KF8: bytes of the main (HTML) flow; CSS and other flows follow it. */
  fdst: number;
  title: string;
  exth: Map<number, Uint8Array[]>;
}

function readHeader(src: ByteSource, pdb: Pdb, index: number): Header {
  const start = pdb.offsets[index];
  const rec = src.read(start, pdb.offsets[index + 1] - start);
  const compression = be16(rec, 0);
  const textLength = be32(rec, 4);
  const textRecords = be16(rec, 8);
  const encryption = be16(rec, 12);
  const h: Header = {
    base: index,
    compression,
    textLength,
    textRecords,
    encryption,
    encoding: 1252,
    version: 0,
    firstImage: NO_INDEX,
    extraFlags: 0,
    fdst: NO_INDEX,
    title: '',
    exth: new Map(),
  };
  if (rec.length < 20 || String.fromCharCode(...rec.subarray(16, 20)) !== 'MOBI') return h; // plain PalmDOC
  const headerLength = be32(rec, 20);
  h.encoding = be32(rec, 28);
  h.version = be32(rec, 36);
  h.firstImage = be32(rec, 108);
  if (headerLength >= 0xe4) h.extraFlags = be16(rec, 242);
  if (h.version >= 8 && headerLength >= 0xb8) h.fdst = be32(rec, 192);
  const nameOffset = be32(rec, 84);
  const nameLength = be32(rec, 88);
  const dec = createDecoder(h.encoding === 65001 ? 'utf-8' : 'windows-1252', false);
  if (nameOffset && nameOffset + nameLength <= rec.length) h.title = dec.decode(rec.subarray(nameOffset, nameOffset + nameLength)).trim();
  // EXTH block: metadata like author, language, cover.
  if (be32(rec, 128) & 0x40) {
    let p = 16 + headerLength;
    if (String.fromCharCode(...rec.subarray(p, p + 4)) === 'EXTH') {
      const count = be32(rec, p + 8);
      p += 12;
      for (let i = 0; i < count && p + 8 <= rec.length; i++) {
        const type = be32(rec, p);
        const len = be32(rec, p + 4);
        if (len < 8) break;
        const data = rec.subarray(p + 8, p + len);
        const list = h.exth.get(type);
        if (list) list.push(data);
        else h.exth.set(type, [data]);
        p += len;
      }
    }
  }
  return h;
}

/** Undo PalmDOC (LZ77-style) compression of one text record. */
export function palmdocDecompress(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length * 8 + 16);
  let o = 0;
  for (let i = 0; i < data.length; ) {
    const c = data[i++];
    if (c === 0 || (c >= 9 && c <= 0x7f)) out[o++] = c;
    else if (c <= 8) {
      for (let k = 0; k < c && i < data.length; k++) out[o++] = data[i++];
    } else if (c >= 0xc0) {
      out[o++] = 0x20;
      out[o++] = c ^ 0x80;
    } else {
      const pair = ((c << 8) | data[i++]) & 0x3fff;
      const dist = pair >> 3;
      const len = (pair & 7) + 3;
      for (let k = 0; k < len; k++) {
        out[o] = out[o - dist];
        o++;
      }
    }
  }
  return out.subarray(0, o);
}

/** Bytes at the end of a text record that aren't text (indexing data). */
export function trailingSize(rec: Uint8Array, flags: number): number {
  let size = 0;
  for (let f = flags >> 1; f; f >>= 1) {
    if (f & 1) {
      // A backwards varint: 7 bits per byte, the highest byte has bit 7 set.
      let value = 0;
      let shift = 0;
      let end = rec.length - size;
      while (end > 0) {
        const v = rec[end - 1];
        value |= (v & 0x7f) << shift;
        shift += 7;
        end--;
        if (v & 0x80 || shift >= 28) break;
      }
      size += value;
    }
  }
  if (flags & 1) size += (rec[rec.length - size - 1] & 3) + 1;
  return size;
}

function sniffImageExt(head: Uint8Array): string | null {
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpg';
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'gif';
  if (head[0] === 0x42 && head[1] === 0x4d) return 'bmp';
  return null;
}

/** Kindle base-32 numbers ("kindle:embed:000A") use 0-9A-V. */
function base32(s: string): number {
  return parseInt(s, 32);
}

const exthString = (h: Header, type: number) => {
  const v = h.exth.get(type);
  if (!v) return '';
  const dec = createDecoder(h.encoding === 65001 ? 'utf-8' : 'windows-1252', false);
  return v.map((d) => dec.decode(d).trim()).filter(Boolean).join(', ');
};

const exthNumber = (h: Header, type: number): number | null => {
  const v = h.exth.get(type)?.[0];
  return v && v.length >= 4 ? be32(v, 0) : null;
};

export async function ingestMobi(ctx: IngestContext): Promise<Manifest> {
  const { src } = ctx;
  const pdb = readPdb(src);
  // The list of records at the start still names those a file cut short (a
  // download that didn't finish) has lost: its header, or text, runs past the
  // end. (Pictures after the text can go missing alone.)
  const runsPast = (index: number) => pdb.offsets[index + 1] > src.size;
  if (runsPast(0)) throw new MobiError(CUT_SHORT);
  const h = readHeader(src, pdb, 0);
  if (h.encryption) throw new MobiError(DRM_MESSAGE);
  if (h.compression === 17480) throw new MobiError('This Kindle book uses HUFF/CDIC compression, which isn’t supported yet.');
  if (h.compression !== 1 && h.compression !== 2) throw new MobiError(`Unknown Kindle compression (${h.compression}).`);
  const count = Math.min(h.textRecords, pdb.offsets.length - 2 - h.base);
  if (count > 0 && runsPast(h.base + count)) throw new MobiError(CUT_SHORT);

  const kf8 = h.version >= 8;
  const title = cleanText(exthString(h, 503) || h.title || ctx.fallbackTitle);
  const author = cleanText(exthString(h, 100));
  const lang = exthString(h, 524);

  const w = new BookWriter(ctx.sink);
  const images: Record<string, ImageRef> = {};
  const firstImage = h.firstImage !== NO_INDEX ? h.base + h.firstImage : -1;

  // Each picture's page space, from the size the start of its record gives.
  const imageSpace = new Map<string, number>();
  const probe = new PictureProbe();
  const imageRef = (recIndex: number): string | null => {
    if (firstImage < 0 || recIndex < firstImage || recIndex >= pdb.offsets.length - 1) return null;
    const key = `rec:${recIndex}`;
    if (!images[key]) {
      const off = pdb.offsets[recIndex];
      const len = pdb.offsets[recIndex + 1] - off;
      const head = src.read(off, Math.min(len, 4 * 1024));
      const ext = sniffImageExt(head);
      if (!ext) return null;
      images[key] = { pdb: [off, len], ext };
      const lines = probe.lines(head, len, (n) => src.read(off, Math.min(len, n)));
      if (lines !== undefined) imageSpace.set(key, lines);
    }
    return key;
  };

  // Cover for the library.
  let cover: string | undefined;
  let coverFile: string | undefined;
  const coverOffset = exthNumber(h, 201);
  if (coverOffset !== null && firstImage >= 0) {
    const key = imageRef(firstImage + coverOffset);
    const ref = key ? images[key] : undefined;
    if (ref && 'pdb' in ref) {
      try {
        coverFile = `cover.${ref.ext}`;
        ctx.sink.writeImage(coverFile, src.read(ref.pdb[0], ref.pdb[1]));
        images.__cover = { file: coverFile };
        cover = '__cover';
      } catch {
        coverFile = undefined;
      }
    }
  }
  ctx.meta?.({ title, author: author || undefined, coverFile });

  const html = new HtmlToBlocks(w, {
    image: (src2) => {
      // KF7: <img recindex="00012">, KF8: src="kindle:embed:000C?mime=image/jpeg" (1-based).
      const rec = /^recindex:(\d+)$/.exec(src2);
      if (rec) return imageRef(firstImage + Number(rec[1]) - 1);
      const embed = /^kindle:embed:([0-9A-Va-v]+)/.exec(src2);
      if (embed) return imageRef(firstImage + base32(embed[1]) - 1);
      return null;
    },
    imageLines: (key) => imageSpace.get(key),
  });
  const tok = new MarkupTokenizer(html);
  const decoder = createDecoder(h.encoding === 65001 || kf8 ? 'utf-8' : 'windows-1252');

  // KF8 keeps stylesheets after the HTML in the same text; stop where the HTML flow ends.
  let textEnd = Infinity;
  if (kf8 && h.fdst !== NO_INDEX) {
    const fi = h.base + h.fdst;
    if (fi < pdb.offsets.length - 1) {
      const fdst = src.read(pdb.offsets[fi], Math.min(64, pdb.offsets[fi + 1] - pdb.offsets[fi]));
      if (String.fromCharCode(...fdst.subarray(0, 4)) === 'FDST' && be32(fdst, 8) > 0) textEnd = be32(fdst, 16);
    }
  }
  let done = 0;
  // Plain PalmDOC (.pdb/.prc without a MOBI header) is text, not HTML: escape
  // it and make each line a paragraph, as for a .txt file.
  const plain = h.version === 0;
  const feed = (t: string) => {
    if (!plain) return tok.feed(t);
    tok.feed(t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\r?\n/g, '</p><p>'));
  };
  if (plain) tok.feed('<p>');

  for (let i = 1; i <= count; i++) {
    const idx = h.base + i;
    const start = pdb.offsets[idx];
    let rec = src.read(start, pdb.offsets[idx + 1] - start);
    const trail = trailingSize(rec, h.extraFlags);
    if (trail > 0 && trail < rec.length) rec = rec.subarray(0, rec.length - trail);
    let text = h.compression === 2 ? palmdocDecompress(rec) : rec;
    if (done + text.length > textEnd) text = text.subarray(0, Math.max(0, textEnd - done));
    done += text.length;
    feed(decoder.decode(text));
    if (done >= textEnd) break;
    ctx.progress(i / count);
    await ctx.pause();
    probe.reset();
  }
  feed(decoder.end());
  if (plain) tok.feed('</p>');
  tok.end();
  html.finish();
  w.finish();
  await ctx.pause();

  return {
    v: ENGINE_VERSION,
    format: kf8 ? 'azw3' : 'mobi',
    title,
    author,
    lang: bookLanguage(lang, w.textSample()),
    totalBlocks: w.totalBlocks,
    totalChars: w.totalChars,
    chunks: w.chunks,
    weights: w.weights,
    opens: w.opens,
    toc: w.headings,
    images,
    cover,
  };
}
