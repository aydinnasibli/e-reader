/// <reference types="node" />
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import type { BookSink, ByteSource, ChunkInfo, IngestContext } from '../src/engine/io';
import type { Block, ChunkFile, Manifest } from '../src/engine/types';
import { ingestBook } from '../src/engine/ingest';

export class MemorySource implements ByteSource {
  constructor(private bytes: Uint8Array) {}
  get size() {
    return this.bytes.length;
  }
  read(offset: number, length: number) {
    return this.bytes.slice(offset, offset + length);
  }
}

export class FileSource implements ByteSource {
  private fd: number;
  readonly size: number;
  constructor(path: string) {
    this.fd = openSync(path, 'r');
    this.size = fstatSync(this.fd).size;
  }
  read(offset: number, length: number) {
    const n = Math.max(0, Math.min(length, this.size - offset));
    const buf = new Uint8Array(n);
    readSync(this.fd, buf, 0, n, offset);
    return buf;
  }
  close() {
    closeSync(this.fd);
  }
}

export class MemorySink implements BookSink {
  chunks: string[] = [];
  /** What each chunk was reported as while converting. */
  infos: ChunkInfo[] = [];
  images = new Map<string, Uint8Array | string>();
  bytesWritten = 0;
  constructor(private keep = true) {}
  writeChunk(index: number, json: string, info: ChunkInfo) {
    this.bytesWritten += json.length;
    this.infos[index] = info;
    if (this.keep) this.chunks[index] = json;
  }
  writeImage(name: string, data: Uint8Array) {
    this.images.set(name, data);
  }
  writeImageBase64(name: string, b64: string) {
    this.images.set(name, b64);
  }
  blocks(): Block[] {
    return this.chunks.flatMap((c) => (JSON.parse(c) as ChunkFile).b);
  }
}

export async function ingestBytes(bytes: Uint8Array, name: string) {
  const sink = new MemorySink();
  const ctx: IngestContext = {
    src: new MemorySource(bytes),
    sink,
    progress() {},
    pause: async () => {},
    fallbackTitle: name,
  };
  const manifest: Manifest = await ingestBook(ctx, name);
  return { manifest, sink, blocks: sink.blocks() };
}

export const enc = (s: string) => new TextEncoder().encode(s);

/** `s` in a one-byte encoding Node knows ('windows-1254', 'iso-8859-9'...), from Node's own decoder. */
export function legacy(s: string, label: string): Uint8Array {
  const d = new TextDecoder(label);
  const rev = new Map<string, number>();
  for (let b = 255; b >= 0; b--) rev.set(d.decode(new Uint8Array([b])), b);
  return Uint8Array.from([...s].map((ch) => {
    const b = rev.get(ch);
    if (b === undefined) throw new Error(`no ${label} byte for ${ch}`);
    return b;
  }));
}

export interface EpubParts {
  /** Chapter path under OEBPS/ -> its XHTML (or bytes). In the spine in this order unless `spine` says otherwise. */
  chapters: Record<string, string | Uint8Array>;
  /** OPF <metadata> content. */
  metadata?: string;
  /** More <item>s for the OPF manifest. */
  items?: string;
  /** Spine item ids (chapters are c0, c1...). */
  spine?: string[];
  /** The nav document's body; none if left out. */
  nav?: string;
  /** More files, by full path. */
  files?: Record<string, string | Uint8Array>;
  /** OPF <guide> content. */
  guide?: string;
}

/** A small EPUB 3 from its parts. */
export function makeEpub(o: EpubParts): Uint8Array {
  const names = Object.keys(o.chapters);
  let items = names.map((n, i) => `<item id="c${i}" href="${n}" media-type="application/xhtml+xml"/>`).join('');
  if (o.nav !== undefined) items += '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>';
  items += o.items ?? '';
  const spine = (o.spine ?? names.map((_, i) => `c${i}`)).map((id) => `<itemref idref="${id}"/>`).join('');
  const bytes = (d: string | Uint8Array) => (typeof d === 'string' ? strToU8(d) : d);
  const f: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata>${o.metadata ?? '<dc:title>T</dc:title>'}</metadata>` +
        `<manifest>${items}</manifest><spine>${spine}</spine>${o.guide ? `<guide>${o.guide}</guide>` : ''}</package>`,
    ),
  };
  if (o.nav !== undefined) f['OEBPS/nav.xhtml'] = strToU8(`<html xmlns:epub="http://www.idpf.org/2007/ops"><body>${o.nav}</body></html>`);
  for (const [n, d] of Object.entries(o.chapters)) f[`OEBPS/${decodeURIComponent(n)}`] = bytes(d);
  for (const [n, d] of Object.entries(o.files ?? {})) f[n] = bytes(d);
  return zipSync(f);
}

/** An XHTML page with this body (and head). */
export const xhtml = (body: string, head = '<title>x</title>') =>
  `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head>${head}</head><body>${body}</body></html>`;
