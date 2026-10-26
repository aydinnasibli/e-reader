// FictionBook 2: one big XML file, often in windows-1251, with images embedded
// as base64 at the end. Parsed as a stream; images are written straight to
// files as they are reached.

import { MarkupDecoder } from './decode';
import { BookError, CUT_SHORT, type IngestContext, READ_SLICE } from './io';
import { bookLanguage } from './language';
import { type MarkupHandler, MarkupTokenizer } from './markup';
import { BOLD, type BlockKind, ENGINE_VERSION, ITALIC, MONO, type Position, SUB, SUP, type ImageRef, type Manifest, type TocEntry } from './types';
import { BookWriter, cleanText } from './writer';
import type { ZipArchive, ZipEntry } from './zip';

const INLINE: Record<string, number> = {
  strong: BOLD, emphasis: ITALIC, code: MONO, sup: SUP, sub: SUB,
};
const QUOTE = new Set(['epigraph', 'cite', 'annotation', 'text-author']);
const NOT_BASE64 = /[^A-Za-z0-9+/=]/;
const NOT_BASE64_ALL = /[^A-Za-z0-9+/=]+/g;

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
  private sawBody = false;
  /** The root element was closed: the file doesn't stop partway. */
  private closedRoot = false;
  /** Inside <body name="notes"> (footnotes): no chapter per note, no TOC entry per note. */
  private notesBody = false;
  private section = 0;
  private titleDepth = 0;
  private titleText = '';
  private titleBlock = 0;
  private subtitle = 0;
  private quote = 0;
  private poem = 0;
  private styles: { style: number; link: string | undefined }[] = [];
  private style = 0;
  private link: string | undefined;
  /** Footnotes: link targets seen so far, and where linked ids (and everything in the notes body) start/end. */
  linkKeys = new Set<string>();
  notes: Record<string, [number, number]> = {};
  /** Where each id is (first time seen), for links to places before them; and its exact place when it's inside the text. */
  idBlock = new Map<string, number>();
  idPlace = new Map<string, Position>();
  /** Path depth -> id being tracked there. */
  private tracked = new Map<number, string>();
  /** A picture being read: its base64 text, cleaned of line breaks a piece at a time as it arrives. */
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
      this.sawBody = true;
      this.notesBody = attrs.name === 'notes' || attrs.name === 'comments';
      this.w.chapterBreak();
      return;
    }
    if (!this.bodyDepth) return;
    const w = this.w;
    const id = attrs.id;
    switch (name) {
      case 'section':
        this.section++;
        if (this.section === 1 && !this.notesBody) w.chapterBreak();
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
      case 'a': {
        const href = hrefAttr(attrs);
        let link: string | undefined;
        if (href.startsWith('#')) {
          link = href;
          this.linkKeys.add(href);
        }
        this.pushStyle(attrs.type === 'note' ? SUP : 0, link);
        break;
      }
      default:
        if (QUOTE.has(name)) {
          w.endBlock();
          this.quote++;
          this.applyKind();
        } else if (INLINE[name] !== undefined) this.pushStyle(INLINE[name]);
    }
    // Ids are opened after the element's own block handling, so they point at its first block.
    if (id) {
      const key = '#' + id;
      if (!this.idBlock.has(key)) {
        this.idBlock.set(key, w.blockIndex);
        const place = w.mark();
        if (place) this.idPlace.set(key, place);
      }
      // A note: linked to already, or in the notes body (linked to from before it or after).
      if ((this.linkKeys.has(key) || this.notesBody) && !this.notes[key]) {
        this.notes[key] = [w.blockIndex, w.blockIndex];
        this.tracked.set(this.path.length, key);
      }
    }
  }

  /** The file stops partway through the text, or before it: a download cut short (pictures after the text may go missing alone). */
  get cutShort(): boolean {
    return !this.closedRoot && (this.bodyDepth > 0 || !this.sawBody);
  }

  close(name: string) {
    if (name === 'fictionbook') this.closedRoot = true;
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
      this.notesBody = false;
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
          const t = cleanText(this.titleText.replace(/\s+/g, ' ').trim());
          // In the notes body only its own title goes in the TOC, not every note's number.
          const listed = this.notesBody ? this.section === 0 : this.section > 0;
          if (t && listed) this.toc.push({ t: t.length > 120 ? t.slice(0, 117) + '…' : t, l: Math.max(0, this.section - 1), b: this.titleBlock });
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
    // End every tracked id at or below the closed element (index i => depth i + 1).
    for (const [depth, key] of this.tracked) {
      if (depth > i) {
        const n = this.notes[key];
        if (n) n[1] = Math.max(n[1], w.blockIndex);
        this.tracked.delete(depth);
      }
    }
  }

  text(t: string) {
    if (this.binary) {
      this.binary.parts.push(NOT_BASE64.test(t) ? t.replace(NOT_BASE64_ALL, '') : t);
      return;
    }
    if (this.inDescription) {
      if (this.capture) this.capturedText += t;
      return;
    }
    if (!this.bodyDepth) return;
    if (this.titleDepth) this.titleText += ' ' + t;
    this.w.text(t, this.style, this.link);
  }

  private capturedText = '';

  private startCapture(what: string) {
    this.capture = what;
    this.capturedText = '';
  }

  private endCapture() {
    const v = cleanText(this.capturedText.replace(/\s+/g, ' ').trim());
    if (v) {
      if (this.capture === 'title' && !this.title) this.title = v;
      else if (this.capture === 'lang' && !this.lang) this.lang = v;
      else if (this.capture === 'author') this.author.push(v);
    }
    this.capture = '';
  }

  private pushStyle(s: number, link?: string) {
    this.styles.push({ style: this.style, link: this.link });
    this.style |= s;
    if (link) this.link = link;
  }

  private popStyle() {
    const prev = this.styles.pop();
    this.style = prev?.style ?? 0;
    this.link = prev?.link;
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
    const data = b.parts.join('');
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
  // The encoding: a BOM, the XML declaration (checked against the bytes) or a guess.
  const decoder = new MarkupDecoder();
  const feed = (bytes: Uint8Array) => tok.feed(decoder.decode(bytes));

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
  tok.feed(decoder.end());
  tok.end();
  if (h.cutShort) throw new BookError(CUT_SHORT);
  w.finish();
  await ctx.pause();

  const images = h.images;
  let cover: string | undefined;
  if (h.coverId && images[h.coverId]) cover = h.coverId;
  // Notes that are linked to; other links (back to where a note was referenced) go to their place.
  const notes: Record<string, [number, number]> = {};
  const anchors: Record<string, number> = {};
  const anchorOffsets: Record<string, number> = {};
  for (const key of h.linkKeys) {
    if (h.notes[key]) notes[key] = h.notes[key];
    else {
      const place = h.idPlace.get(key);
      const b = place?.b ?? h.idBlock.get(key);
      if (b !== undefined && b < w.totalBlocks) {
        anchors[key] = b;
        if (place?.o) anchorOffsets[key] = place.o;
      }
    }
  }

  return {
    v: ENGINE_VERSION,
    format: 'fb2',
    title: h.title || ctx.fallbackTitle,
    author: h.authors.join(', '),
    lang: bookLanguage(h.lang, w.textSample()),
    totalBlocks: w.totalBlocks,
    totalChars: w.totalChars,
    chunks: w.chunks,
    weights: w.weights,
    opens: w.opens,
    toc: h.toc.length ? h.toc : w.headings,
    images,
    cover,
    notes,
    anchors,
    anchorOffsets,
  };
}
