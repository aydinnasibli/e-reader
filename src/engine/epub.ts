// EPUB: a ZIP of XHTML chapters plus an OPF package file. Chapters are
// decompressed, decoded and parsed as streams; images stay inside the ZIP
// and are extracted only when the reader actually shows them.

import { StyleSheet } from './css';
import { MarkupDecoder, decodeMarkup } from './decode';
import { HtmlToBlocks } from './html';
import { BookError, DRM_MESSAGE, type IngestContext } from './io';
import { bookLanguage } from './language';
import { type MarkupHandler, MarkupTokenizer } from './markup';
import { ENGINE_VERSION, type ImageRef, type Manifest, type Position, type TocEntry } from './types';
import { pictureSize } from './picture';
import { BookWriter, cleanText, pictureLines } from './writer';
import type { ZipArchive } from './zip';

interface ManifestItem {
  id: string;
  href: string; // full path inside the zip
  type: string;
  props: string;
}

interface Package {
  title: string;
  authors: string[];
  lang: string;
  items: Map<string, ManifestItem>;
  spine: string[];
  tocId: string;
  coverId: string;
  /** The guide's cover page or picture (EPUB 2), full path. */
  guideCover: string;
}

interface RawToc {
  t: string;
  l: number;
  href: string; // full path + optional #fragment
}

export function resolvePath(baseFile: string, href: string): string {
  const clean = href.split('#')[0];
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    // keep as is
  }
  if (decoded.startsWith('/')) decoded = decoded.slice(1);
  const parts = baseFile.split('/');
  parts.pop();
  for (const seg of decoded.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  // Composed, as the ZIP's names are (macOS tools write either form).
  return cleanText(parts.join('/'));
}

/** The #fragment of a link, percent-decoded (ids are matched as written in the HTML). */
function fragmentOf(href: string): string {
  const i = href.indexOf('#');
  if (i < 0) return '';
  try {
    return decodeURIComponent(href.slice(i + 1));
  } catch {
    return href.slice(i + 1);
  }
}

function parseXml(bytes: Uint8Array, handler: MarkupHandler) {
  const t = new MarkupTokenizer(handler);
  t.feed(decodeMarkup(bytes));
  t.end();
}

function readContainer(zip: ZipArchive): string {
  const c = zip.find('META-INF/container.xml');
  if (c) {
    let path = '';
    parseXml(zip.read(c), {
      open(name, attrs) {
        if (name === 'rootfile' && !path && attrs['full-path']) path = attrs['full-path'];
      },
      close() {},
      text() {},
    });
    if (path) return path;
  }
  for (const name of zip.entries.keys()) if (name.toLowerCase().endsWith('.opf')) return name;
  throw new BookError('This EPUB is damaged: the list of its chapters is missing.');
}

function readPackage(zip: ZipArchive, opfPath: string): Package {
  const entry = zip.find(opfPath);
  if (!entry) throw new BookError('This EPUB is damaged: the list of its chapters is missing.');
  const pkg: Package = { title: '', authors: [], lang: '', items: new Map(), spine: [], tocId: '', coverId: '', guideCover: '' };
  let capture: 'title' | 'creator' | 'language' | null = null;
  let buf = '';
  let inMetadata = false;
  parseXml(zip.read(entry), {
    open(name, attrs) {
      if (name === 'metadata') inMetadata = true;
      else if (inMetadata && (name === 'title' || name === 'creator' || name === 'language')) {
        capture = name;
        buf = '';
      } else if (name === 'meta' && attrs.name === 'cover' && attrs.content) pkg.coverId = attrs.content;
      else if (name === 'item' && attrs.id && attrs.href) {
        pkg.items.set(attrs.id, {
          id: attrs.id,
          href: resolvePath(opfPath, attrs.href),
          type: (attrs['media-type'] ?? '').trim().toLowerCase(),
          props: attrs.properties ?? '',
        });
      } else if (name === 'spine') pkg.tocId = attrs.toc ?? '';
      else if (name === 'itemref' && attrs.idref) pkg.spine.push(attrs.idref);
      else if (name === 'reference' && attrs.href && /^cover$/i.test(attrs.type ?? '') && !pkg.guideCover) pkg.guideCover = resolvePath(opfPath, attrs.href);
    },
    close(name) {
      if (name === 'metadata') inMetadata = false;
      if (capture && name === capture) {
        const v = cleanText(buf.replace(/\s+/g, ' ').trim());
        if (v) {
          if (capture === 'title' && !pkg.title) pkg.title = v;
          else if (capture === 'creator') pkg.authors.push(v);
          else if (capture === 'language' && !pkg.lang) pkg.lang = v;
        }
        capture = null;
      }
    },
    text(t) {
      if (capture) buf += t;
    },
  });
  return pkg;
}

// Font obfuscation (IDPF and Adobe): only embedded fonts are scrambled, the text is readable.
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);
// Files the common kinds of DRM add. They only tell which kind it is: many
// stores leave them in books whose text isn't encrypted at all.
const DRM_KINDS = [
  ['META-INF/rights.xml', 'Adobe DRM'],
  ['META-INF/sinf.xml', 'Apple FairPlay'],
  ['META-INF/license.lcpl', 'Readium LCP'],
] as const;
const CONTENT_FILE = /\.(x?html?|xml|opf|ncx)$/i;

/** Files META-INF/encryption.xml lists as really encrypted (not just obfuscated fonts). */
function encryptedFiles(zip: ZipArchive): string[] {
  const e = zip.find('META-INF/encryption.xml');
  if (!e) return [];
  const out: string[] = [];
  let inData = false;
  let keyDepth = 0; // inside <KeyInfo>/<EncryptedKey>, whose methods are about the key
  let algorithm = '';
  let uri = '';
  parseXml(zip.read(e), {
    open(name, attrs) {
      if (name === 'encrypteddata') {
        inData = true;
        algorithm = uri = '';
      } else if (!inData) return;
      else if (name === 'keyinfo' || name === 'encryptedkey') keyDepth++;
      else if (name === 'encryptionmethod' && !keyDepth && !algorithm) algorithm = (attrs.algorithm ?? '').trim();
      else if (name === 'cipherreference' && !keyDepth && attrs.uri) uri = attrs.uri;
    },
    close(name) {
      if (!inData) return;
      if (name === 'keyinfo' || name === 'encryptedkey') keyDepth = Math.max(0, keyDepth - 1);
      else if (name === 'encrypteddata') {
        // Paths in encryption.xml are relative to the root of the container.
        if (uri && !FONT_OBFUSCATION.has(algorithm)) out.push(resolvePath('', uri));
        inData = false;
        keyDepth = 0;
      }
    },
    text() {},
  });
  return out;
}

/**
 * Refuse copy-protected books up front with a clear message, instead of
 * producing pages of scrambled bytes: books whose text is encrypted (Adobe
 * ADEPT, Apple FairPlay, Readium LCP or any other kind). Books whose only
 * "encryption" is font obfuscation are fine.
 */
function checkDrm(zip: ZipArchive, encrypted: string[], pkg?: Package) {
  if (!encrypted.length) return;
  const content = new Set<string>();
  if (pkg) {
    for (const id of pkg.spine) {
      const it = pkg.items.get(id);
      if (it) content.add(it.href.toLowerCase());
    }
  }
  if (!encrypted.some((p) => CONTENT_FILE.test(p) || content.has(p.toLowerCase()))) return;
  const kind = DRM_KINDS.find(([file]) => zip.find(file))?.[1];
  throw new BookError(kind ? `${DRM_MESSAGE} It uses ${kind}.` : DRM_MESSAGE);
}

/** The table of contents nav: epub:type="toc" (any namespace prefix), or role="doc-toc". */
function isTocNav(attrs: Record<string, string>): boolean {
  for (const k in attrs) if ((k === 'type' || k.endsWith(':type') || k === 'role') && /\b(doc-)?toc\b/.test(attrs[k])) return true;
  return false;
}

function readNav(zip: ZipArchive, item: ManifestItem): RawToc[] {
  const e = zip.find(item.href);
  if (!e) return [];
  const out: RawToc[] = [];
  let inToc = 0; // depth of <nav> elements while inside the toc nav
  let olDepth = 0;
  let link: RawToc | null = null;
  parseXml(zip.read(e), {
    open(name, attrs) {
      if (name === 'nav') {
        if (inToc) inToc++;
        else if (isTocNav(attrs)) inToc = 1;
      } else if (!inToc) return;
      else if (name === 'ol') olDepth++;
      else if (name === 'a' && attrs.href) link = { t: '', l: Math.max(0, olDepth - 1), href: attrs.href };
    },
    close(name) {
      if (!inToc) return;
      if (name === 'nav') inToc--;
      else if (name === 'ol') olDepth--;
      else if (name === 'a' && link) {
        const f = fragmentOf(link.href);
        link.href = resolvePath(item.href, link.href) + (f ? '#' + f : '');
        link.t = cleanText(link.t.replace(/\s+/g, ' ').trim());
        if (link.t) out.push(link);
        link = null;
      }
    },
    text(t) {
      if (link) link.t += t;
    },
  });
  return out;
}

function readNcx(zip: ZipArchive, item: ManifestItem): RawToc[] {
  const e = zip.find(item.href);
  if (!e) return [];
  const out: RawToc[] = [];
  let depth = 0;
  let inLabel = false;
  let label = '';
  parseXml(zip.read(e), {
    open(name, attrs) {
      if (name === 'navpoint') {
        depth++;
        label = '';
      } else if (name === 'navlabel') inLabel = true;
      else if (name === 'content' && attrs.src && depth > 0) {
        const t = cleanText(label.replace(/\s+/g, ' ').trim());
        const f = fragmentOf(attrs.src);
        if (t) out.push({ t, l: depth - 1, href: resolvePath(item.href, attrs.src) + (f ? '#' + f : '') });
        label = '';
      }
    },
    close(name) {
      if (name === 'navpoint') depth--;
      else if (name === 'navlabel') inLabel = false;
    },
    text(t) {
      if (inLabel) label += t;
    },
  });
  return out;
}

function extOf(path: string, type = ''): string {
  const m = /\.([a-z0-9]{2,5})$/i.exec(path);
  if (m) return m[1].toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('gif')) return 'gif';
  if (type.includes('svg')) return 'svg';
  if (type.includes('webp')) return 'webp';
  return 'jpg';
}

const PICTURE = /\.(jpe?g|png|gif|webp|bmp|svg)$/i;
const PAGE_TYPES = new Set(['application/xhtml+xml', 'text/html', 'image/svg+xml', 'application/x-dtbook+xml', 'text/x-oeb1-document']);

/**
 * How a spine item is read: as a page of (X)HTML or SVG, as a picture, or
 * not at all (a stylesheet, a font: read as text they'd be pages of code or
 * binary). A missing or odd media type goes by the file name.
 */
function spineKind(item: ManifestItem): 'html' | 'picture' | null {
  const t = item.type;
  if (PAGE_TYPES.has(t)) return 'html';
  if (t.startsWith('image/')) return 'picture';
  if (t.startsWith('font/') || /css|font|javascript|ncx|audio|video/.test(t)) return null;
  if (/\.(x?html?|xml|svg)$/i.test(item.href)) return 'html';
  return PICTURE.test(item.href) ? 'picture' : null;
}

/**
 * The first picture an (X)HTML page shows, as a full path. `cover`: only
 * from a page that's little more than the picture (not a chapter with one).
 */
function firstPicture(zip: ZipArchive, page: string, cover = false): string | null {
  const e = zip.find(page);
  if (!e || e.size > 256 * 1024) return null;
  let src: string | null = null;
  let text = 0;
  let body = false;
  try {
    parseXml(zip.read(e), {
      open(name, attrs) {
        if (name === 'body') body = true;
        if (!src && (name === 'img' || name === 'image')) src = attrs.src ?? attrs['xlink:href'] ?? attrs.href ?? null;
      },
      close() {},
      text(t) {
        if (body) text += t.trim().length;
      },
    });
  } catch {
    return null;
  }
  if (cover && text > 300) return null;
  return src && !/^(https?:|data:)/i.test(src) ? resolvePath(page, src) : null;
}

/**
 * The cover picture: the one the metadata names (by id, or by path as some
 * tools write it), the EPUB 3 cover-image, the guide's cover, a picture
 * called "cover", or else the picture on the first page.
 */
function findCover(zip: ZipArchive, pkg: Package, opfPath: string): { path: string; type: string } | null {
  const items = [...pkg.items.values()];
  let byPath: Map<string, ManifestItem> | null = null;
  const itemAt = (path: string): ManifestItem => {
    byPath ??= new Map(items.map((i) => [i.href.toLowerCase(), i]));
    return byPath.get(path.toLowerCase()) ?? { id: '', href: path, type: '', props: '' };
  };
  const picture = (i: ManifestItem | undefined) => !!i && (i.type.startsWith('image/') || PICTURE.test(i.href)) && !!zip.find(i.href);
  const pictureOn = (page: string, cover = false) => {
    const p = firstPicture(zip, page, cover);
    return p ? itemAt(p) : undefined;
  };
  // Tried in turn, each only if the ones before found nothing.
  const tries: (() => ManifestItem | undefined)[] = [
    () => (pkg.coverId ? (pkg.items.get(pkg.coverId) ?? itemAt(resolvePath(opfPath, pkg.coverId))) : undefined),
    () => items.find((i) => /\bcover-image\b/.test(i.props)),
    () => {
      if (!pkg.guideCover) return undefined;
      const g = itemAt(pkg.guideCover);
      return picture(g) ? g : pictureOn(pkg.guideCover);
    },
    // A cover page named as the metadata's cover (the id of an XHTML page).
    () => {
      const named = pkg.items.get(pkg.coverId);
      return named && !picture(named) ? pictureOn(named.href) : undefined;
    },
    () => items.find((i) => picture(i) && /cover/i.test(i.id + ' ' + i.href)),
    () => {
      const first = pkg.items.get(pkg.spine[0]);
      const kind = first ? spineKind(first) : null;
      return kind === 'picture' ? first : kind === 'html' ? pictureOn(first!.href, true) : undefined;
    },
  ];
  for (const t of tries) {
    const c = t();
    if (c && picture(c)) return { path: c.href, type: c.type };
  }
  return null;
}

/** Bytes of pictures read for their sizes between two pauses. */
const PROBE_BUDGET = 64 * 1024;
/** A note is shorter than this, in blocks; a link to more is to a chapter or section. */
const NOTE_MAX_BLOCKS = 20;

/** A link to a whole file this small is a note (some books keep one note a file); a bigger one is a chapter. */
const NOTE_FILE_BLOCKS = 6;

export async function ingestEpub(ctx: IngestContext, zip: ZipArchive): Promise<Manifest> {
  // Checked before the package too: an encrypted package can't be parsed.
  const encrypted = encryptedFiles(zip);
  checkDrm(zip, encrypted);
  const opfPath = readContainer(zip);
  const pkg = readPackage(zip, opfPath);
  checkDrm(zip, encrypted, pkg);
  // (Big books have big package and contents files: a pause after each step.)
  await ctx.pause();

  // Files by lower-case path, so links and contents that get the case wrong still land.
  const canonical = new Map<string, string>();
  for (const it of pkg.items.values()) if (!canonical.has(it.href.toLowerCase())) canonical.set(it.href.toLowerCase(), it.href);
  const canon = (path: string) => canonical.get(path.toLowerCase()) ?? path;

  let rawToc: RawToc[] = [];
  const navItem = [...pkg.items.values()].find((i) => /\bnav\b/.test(i.props));
  if (navItem) rawToc = readNav(zip, navItem);
  if (!rawToc.length) {
    const ncx = pkg.items.get(pkg.tocId) ?? [...pkg.items.values()].find((i) => i.type === 'application/x-dtbncx+xml');
    if (ncx) rawToc = readNcx(zip, ncx);
  }
  await ctx.pause();

  const w = new BookWriter(ctx.sink);
  const images: Record<string, ImageRef> = {};

  let cover: string | undefined;
  let coverFile: string | undefined;
  const coverItem = findCover(zip, pkg, opfPath);
  if (coverItem) {
    const ce = zip.find(coverItem.path);
    if (ce) {
      const name = 'cover.' + extOf(coverItem.path, coverItem.type);
      try {
        ctx.sink.writeImage(name, zip.read(ce));
        images.__cover = { file: name };
        cover = '__cover';
        coverFile = name;
      } catch {
        // A broken cover shouldn't fail the whole book.
      }
    }
  }

  ctx.meta?.({ title: pkg.title || undefined, author: pkg.authors.join(', ') || undefined, coverFile });
  await ctx.pause();

  const fileStart = new Map<string, number>();
  const fileEnd = new Map<string, number>();
  // Where each element id is (first time seen), for the contents and for links back:
  // its block, and its exact place when it's inside the text (a note's mark).
  const idBlock = new Map<string, number>();
  const idPlace = new Map<string, Position>();
  const blockOf = (key: string) => idPlace.get(key)?.b ?? idBlock.get(key);
  // Footnotes: every internal link seen so far, and where linked ids start/end.
  const linkKeys = new Set<string>();
  const notes: Record<string, [number, number]> = {};
  // What tells a note from a place to go to: a link reading like a note's
  // mark, or a target saying it's a note; and a target that's a heading.
  const markedLinks = new Set<string>();
  const noteTargets = new Set<string>();
  const placeTargets = new Set<string>();

  // Each picture's page space, from the size its file's first bytes give. That
  // means reading (and inflating) them in the middle of a slice of text, so
  // only so much is read between two pauses; past that a picture counts as
  // an average one. (A chapter of 300 photos would otherwise freeze the app.)
  const imageSpace = new Map<string, number | undefined>();
  let probeBudget = PROBE_BUDGET;
  const imageKey = (path: string): string | null => {
    if (!images[path]) {
      const ie = zip.find(path);
      if (!ie) return null;
      images[path] = { zip: [ie.offset, ie.compressedSize, ie.size, ie.method], ext: extOf(path) };
      let lines: number | undefined;
      if (probeBudget > 0) {
        try {
          const head = zip.head(ie, 4 * 1024);
          probeBudget -= head.length;
          let size = pictureSize(head);
          // A JPEG's size can come after its metadata: a little further, if there's room.
          if (!size && head[0] === 0xff && ie.size > head.length && probeBudget >= 16 * 1024) {
            const more = zip.head(ie, 16 * 1024);
            probeBudget -= more.length;
            size = pictureSize(more);
          }
          if (size) lines = pictureLines(size[0], size[1]);
        } catch {
          // damaged: counted as an average picture
        }
      }
      imageSpace.set(path, lines);
    }
    return path;
  };
  const imageLines = (key: string) => imageSpace.get(key);

  // Style sheets, read once each however many chapters use them.
  const sheets = new Map<string, StyleSheet>();
  const parseStyle = (css: string) => {
    const s = new StyleSheet();
    s.add(css);
    return s;
  };

  const spine = pkg.spine
    .map((id) => pkg.items.get(id))
    .filter((i): i is ManifestItem => !!i)
    .map((item) => ({ item, kind: spineKind(item) }))
    .filter((s): s is { item: ManifestItem; kind: 'html' | 'picture' } => !!s.kind);
  const entries = spine.map((s) => zip.find(s.item.href));
  const totalBytes = entries.reduce((a, e) => a + (e?.compressedSize ?? 0), 0) || 1;
  let doneBytes = 0;

  for (let si = 0; si < spine.length; si++) {
    const { item, kind } = spine[si];
    const entry = entries[si];
    if (!entry) continue;
    w.chapterBreak();
    if (!fileStart.has(item.href)) fileStart.set(item.href, w.blockIndex);
    probeBudget = PROBE_BUDGET;
    if (kind === 'picture') {
      // A page that is only a picture (comics, plates, some covers).
      const key = imageKey(item.href);
      if (key) w.image(key, imageLines(key));
      fileEnd.set(item.href, w.blockIndex);
      doneBytes += entry.compressedSize;
      continue;
    }
    const html = new HtmlToBlocks(w, {
      link: (href) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null; // http:, mailto:, ...
        const frag = fragmentOf(href);
        const path = href.startsWith('#') ? item.href : canon(resolvePath(item.href, href));
        const key = frag ? `${path}#${frag}` : path;
        linkKeys.add(key);
        return key;
      },
      onId: (id, b, place) => {
        const key = `${item.href}#${id}`;
        if (idBlock.has(key)) return;
        idBlock.set(key, b);
        if (place) idPlace.set(key, place);
      },
      onIdStart: (id, b, kind) => {
        const key = `${item.href}#${id}`;
        if (kind === 'note') noteTargets.add(key);
        else if (kind === 'place') placeTargets.add(key);
        if (!linkKeys.has(key) || notes[key]) return false;
        notes[key] = [b, b];
        return true;
      },
      onLinkEnd: (key, mark) => {
        if (mark) markedLinks.add(key);
      },
      onIdEnd: (id, b) => {
        const n = notes[`${item.href}#${id}`];
        if (n) n[1] = Math.max(n[1], b);
      },
      image: (src) => {
        if (/^(https?:|data:)/i.test(src)) return null;
        return imageKey(resolvePath(item.href, src));
      },
      imageLines,
      stylesheet: (href) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
        const path = canon(resolvePath(item.href, href));
        let sheet = sheets.get(path);
        if (!sheet) {
          sheet = new StyleSheet();
          const e = zip.find(path);
          try {
            if (e && e.size < 1024 * 1024) sheet.add(decodeMarkup(zip.read(e)));
          } catch {
            // An unreadable style sheet only loses the book's styling.
          }
          sheets.set(path, sheet);
        }
        return sheet;
      },
      parseStyle,
    });
    const tok = new MarkupTokenizer(html);
    // The encoding: a BOM, the XML declaration or <meta charset> (checked against the bytes) or a guess.
    const decoder = new MarkupDecoder();
    await zip.stream(
      entry,
      (bytes) => tok.feed(decoder.decode(bytes)),
      async (f) => {
        ctx.progress((doneBytes + f * entry.compressedSize) / totalBytes);
        await ctx.pause();
        probeBudget = PROBE_BUDGET;
      },
    );
    tok.feed(decoder.end());
    tok.end();
    html.finish();
    fileEnd.set(item.href, w.blockIndex);
    doneBytes += entry.compressedSize;
  }
  w.finish();
  await ctx.pause();

  // Links to whole files: a short one marked like a note is a note, a chapter is a place to go to.
  // And a link that neither reads like a note's mark nor points at a note
  // (a contents page, "see chapter 3"), or that points at a heading or at
  // something longer than a note, is a place to go to too.
  const anchors: Record<string, number> = {};
  const anchorOffsets: Record<string, number> = {};
  const anchor = (key: string, b: number) => {
    const place = idPlace.get(key);
    anchors[key] = b;
    if (place?.b === b && place.o > 0) anchorOffsets[key] = place.o;
  };
  for (const key of linkKeys) {
    const n = notes[key];
    if (n && !placeTargets.has(key) && n[1] - n[0] <= NOTE_MAX_BLOCKS && (markedLinks.has(key) || noteTargets.has(key))) continue;
    if (n) {
      delete notes[key];
      anchor(key, blockOf(key) ?? n[0]);
      continue;
    }
    if (!key.includes('#')) {
      const b = fileStart.get(key);
      if (b === undefined) continue;
      const end = fileEnd.get(key) ?? b + 1;
      if (end - b <= NOTE_FILE_BLOCKS && markedLinks.has(key)) notes[key] = [b, Math.max(end, b + 1)];
      else anchor(key, b);
      continue;
    }
    // A link to something seen before it: typically a note's way back to where it was referenced.
    const b = blockOf(key);
    if (b !== undefined && b < w.totalBlocks) anchor(key, b);
  }

  let toc: TocEntry[] = [];
  for (const t of rawToc) {
    const hash = t.href.indexOf('#');
    const path = canon(hash >= 0 ? t.href.slice(0, hash) : t.href);
    const b = hash >= 0 ? (blockOf(`${path}#${fragmentOf(t.href)}`) ?? fileStart.get(path)) : fileStart.get(path);
    if (b !== undefined && b < w.totalBlocks) toc.push({ t: t.t, l: t.l, b });
  }
  if (!toc.length) toc = w.headings;

  return {
    v: ENGINE_VERSION,
    format: 'epub',
    title: pkg.title || ctx.fallbackTitle,
    author: pkg.authors.join(', '),
    lang: bookLanguage(pkg.lang, w.textSample()),
    totalBlocks: w.totalBlocks,
    totalChars: w.totalChars,
    chunks: w.chunks,
    weights: w.weights,
    opens: w.opens,
    toc,
    images,
    cover,
    notes,
    anchors,
    anchorOffsets,
  };
}
