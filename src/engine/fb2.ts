// FictionBook 2: one big XML file, often in windows-1251, with images embedded
// as base64 at the end. Parsed as a stream; images are written straight to
// files as they are reached.

import { createDecoder, detectBom, type StreamDecoder, xmlDeclaredEncoding } from './decode';
import { type IngestContext, READ_SLICE } from './io';
import { type MarkupHandler, MarkupTokenizer } from './markup';
import { BOLD, type BlockKind, ITALIC, MONO, SUB, SUP, type ImageRef, type Manifest, type TocEntry } from './types';
import { BookWriter } from './writer';
import type { ZipArchive, ZipEntry } from './zip';

const INLINE: Record<string, number> = {
  strong: BOLD, emphasis: ITALIC, code: MONO, sup: SUP, sub: SUB,
};
const QUOTE = new Set(['epigraph', 'cite', 'annotation', 'text-author']);

function hrefAttr(attrs: Record<string, string>): string {
  for (const k in attrs) if (k === 'href' || k.endsWith(':href')) return attrs[k];
  return '';
}

class Fb2Handler implements MarkupHandler {
  title = '';
  authors: string[] = [];
  lang = '';
  coverId = '';
  toc: TocEntry[] = [];
  images: Record<string, ImageRef> = {};

  private path: string[] = [];
  private inDescription = false;
  private capture = '';
  private author: string[] = [];
  private bodyDepth = 0;
  private section = 0;
  private titleDepth = 0;
  private titleText = '';
  private titleBlock = 0;
  private subtitle = 0;
  private quote = 0;
  private poem = 0;
  private styles: number[] = [];
  private style = 0;
  private binary: { id: string; type: string; parts: string[] } | null = null;

  constructor(
    private w: BookWriter,
    private sink: IngestContext['sink'],
    private onDescription?: () => void,
  ) {}

  open(name: string, attrs: Record<string, string>) {
    this.path.push(name);
    if (name === 'description') this.inDescription = true;
    if (this.inDescription) {
      const parent = this.path[this.path.length - 2];
      const inTitleInfo = this.path.includes('title-info');
      if (inTitleInfo && name === 'book-title') this.startCapture('title');
      else if (inTitleInfo && name === 'lang') this.startCapture('lang');
      else if (inTitleInfo && parent === 'author' && (name === 'first-name' || name === 'middle-name' || name === 'last-name'))
        this.startCapture('author');
      else if (inTitleInfo && name === 'author') this.author = [];
      else if (inTitleInfo && name === 'image' && this.path.includes('coverpage') && !this.coverId)
        this.coverId = hrefAttr(attrs).replace(/^#/, '');
      return;
    }
    if (name === 'binary') {
      this.binary = { id: attrs.id ?? '', type: attrs['content-type'] ?? '', parts: [] };
      return;
    }
    if (name === 'body') {
      this.bodyDepth++;
      this.w.chapterBreak();
      return;
    }
    if (!this.bodyDepth) return;
    const w = this.w;
    switch (name) {
      case 'section':
        this.section++;
        if (this.section === 1) w.chapterBreak();
        else w.endBlock();
        break;
      case 'title':
        w.endBlock();
        this.titleDepth++;
        if (this.titleDepth === 1) {
          this.titleText = '';
          this.titleBlock = w.blockIndex;
        }
        this.applyKind();
        break;
      case 'subtitle':
        this.subtitle++;
        this.applyKind();
        break;
      case 'poem':
      case 'stanza':
        if (name === 'poem') this.poem++;
        w.endBlock();
        this.applyKind();
        break;
      case 'p':
      case 'v':
      case 'td':
      case 'th':
        w.endBlock();
        break;
      case 'empty-line':
        w.emptyLine();
        break;
      case 'image': {
        const id = hrefAttr(attrs).replace(/^#/, '');
        if (id) w.image(id);
        break;
      }
      case 'a':
        this.pushStyle(attrs.type === 'note' ? SUP : 0);
        break;
      default:
        if (QUOTE.has(name)) {
          w.endBlock();
          this.quote++;
          this.applyKind();
        } else if (INLINE[name] !== undefined) this.pushStyle(INLINE[name]);
    }
  }

  close(name: string) {
    // Pop to the matching element; FB2 is XML so this is normally exact.
    const i = this.path.lastIndexOf(name);
    if (i < 0) return;
    this.path.length = i;
    if (name === 'description') {
      this.inDescription = false;
      this.onDescription?.();
      return;
    }
    if (this.inDescription) {
      if (name === 'author' && this.author.length) this.authors.push(this.author.join(' '));
      if (this.capture && (name === 'book-title' || name === 'lang' || name.endsWith('-name'))) this.endCapture();
      return;
    }
    if (name === 'binary') {
      this.finishBinary();
      return;
    }
    if (name === 'body') {
      this.bodyDepth--;
      this.w.endBlock();
      return;
    }
    if (!this.bodyDepth) return;
    const w = this.w;
    switch (name) {
      case 'section':
        w.endBlock();
        this.section--;
        break;
      case 'title':
        w.endBlock();
        this.titleDepth--;
        if (this.titleDepth === 0) {
          const t = this.titleText.replace(/\s+/g, ' ').trim();
          if (t && this.section > 0) this.toc.push({ t: t.length > 120 ? t.slice(0, 117) + '…' : t, l: this.section - 1, b: this.titleBlock });
        }
        this.applyKind();
        break;
      case 'subtitle':
        w.endBlock();
        this.subtitle--;
        this.applyKind();
        break;
      case 'poem':
      case 'stanza':
        w.endBlock();
        if (name === 'poem') this.poem--;
        else w.emptyLine();
        this.applyKind();
        break;
      case 'p':
      case 'v':
      case 'td':
      case 'th':
        w.endBlock();
        break;
      case 'a':
        this.popStyle();
        break;
      default:
        if (QUOTE.has(name)) {
          w.endBlock();
          this.quote--;
          this.applyKind();
        } else if (INLINE[name] !== undefined) this.popStyle();
    }
  }

  text(t: string) {
    if (this.binary) {
      this.binary.parts.push(t);
      return;
    }
    if (this.inDescription) {
      if (this.capture) this.capturedText += t;
      return;
    }
    if (!this.bodyDepth) return;
    if (this.titleDepth) this.titleText += ' ' + t;
    this.w.text(t, this.style);
  }

  private capturedText = '';

  private startCapture(what: string) {
    this.capture = what;
    this.capturedText = '';
  }

  private endCapture() {
    const v = this.capturedText.replace(/\s+/g, ' ').trim();
    if (v) {
      if (this.capture === 'title' && !this.title) this.title = v;
      else if (this.capture === 'lang' && !this.lang) this.lang = v;
      else if (this.capture === 'author') this.author.push(v);
    }
    this.capture = '';
  }

  private pushStyle(s: number) {
    this.styles.push(this.style);
    this.style |= s;
  }

  private popStyle() {
    this.style = this.styles.pop() ?? 0;
  }

  private applyKind() {
    let kind: BlockKind = 'p';
    let level = 0;
    if (this.titleDepth) {
      kind = 'h';
      level = Math.min(Math.max(this.section, 1), 6);
    } else if (this.subtitle) {
      kind = 'h';
      level = 5;
    } else if (this.poem) kind = 'v';
    else if (this.quote) kind = 'q';
    this.w.setKind(kind, level);
  }

  private finishBinary() {
    const b = this.binary;
    this.binary = null;
    if (!b || !b.id) return;
    const data = b.parts.join('').replace(/[^A-Za-z0-9+/=]/g, '');
    if (!data) return;
    const ext = b.type.includes('png') ? 'png' : b.type.includes('gif') ? 'gif' : 'jpg';
    const file = 'b_' + b.id.replace(/[^A-Za-z0-9._-]/g, '_') + '.' + ext;
    try {
      this.sink.writeImageBase64(file, data);
      this.images[b.id] = { file };
    } catch {
      // skip unreadable images
    }
  }
}

/** Stream either a plain .fb2 file or an .fb2 entry inside a zip. */
export async function ingestFb2(ctx: IngestContext, zip?: ZipArchive, entry?: ZipEntry): Promise<Manifest> {
  const w = new BookWriter(ctx.sink);
  const h: Fb2Handler = new Fb2Handler(w, ctx.sink, () =>
    ctx.meta?.({ title: h.title || undefined, author: h.authors.join(', ') || undefined }),
  );
  const tok = new MarkupTokenizer(h);
  let decoder: StreamDecoder | null = null;
  const feed = (bytes: Uint8Array) => {
    if (!decoder) {
      const bom = detectBom(bytes);
      decoder = createDecoder(bom?.enc ?? xmlDeclaredEncoding(bytes) ?? 'utf-8');
      if (bom) bytes = bytes.subarray(bom.skip);
    }
    tok.feed(decoder.decode(bytes));
  };

  if (zip && entry) {
    await zip.stream(entry, feed, async (f) => {
      ctx.progress(f);
      await ctx.pause();
    });
  } else {
    const { src } = ctx;
    for (let pos = 0; pos < src.size; ) {
      const n = Math.min(READ_SLICE, src.size - pos);
      feed(src.read(pos, n));
      pos += n;
      ctx.progress(pos / src.size);
      await ctx.pause();
    }
  }
  if (decoder) tok.feed((decoder as StreamDecoder).end());
  tok.end();
  w.finish();

  const images = h.images;
  let cover: string | undefined;
  if (h.coverId && images[h.coverId]) cover = h.coverId;

  return {
    v: 1,
    format: 'fb2',
    title: h.title || ctx.fallbackTitle,
    author: h.authors.join(', '),
    lang: h.lang || undefined,
    totalBlocks: w.totalBlocks,
    totalChars: w.totalChars,
    chunks: w.chunks,
    toc: h.toc.length ? h.toc : w.headings,
    images,
    cover,
  };
}
