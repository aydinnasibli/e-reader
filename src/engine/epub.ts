// EPUB: a ZIP of XHTML chapters plus an OPF package file. Chapters are
// decompressed, decoded and parsed as streams; images stay inside the ZIP
// and are extracted only when the reader actually shows them.

import { createDecoder, detectBom, type StreamDecoder, xmlDeclaredEncoding } from './decode';
import { HtmlToBlocks } from './html';
import { BookError, type IngestContext } from './io';
import { type MarkupHandler, MarkupTokenizer } from './markup';
import type { ImageRef, Manifest, TocEntry } from './types';
import { BookWriter } from './writer';
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
  return parts.join('/');
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
  t.feed(decodeSmall(bytes));
  t.end();
}

function decodeSmall(bytes: Uint8Array): string {
  const bom = detectBom(bytes);
  const enc = bom?.enc ?? xmlDeclaredEncoding(bytes) ?? 'utf-8';
  const d = createDecoder(enc);
  return d.decode(bytes.subarray(bom?.skip ?? 0)) + d.end();
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
  const pkg: Package = { title: '', authors: [], lang: '', items: new Map(), spine: [], tocId: '', coverId: '' };
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
          type: attrs['media-type'] ?? '',
          props: attrs.properties ?? '',
        });
      } else if (name === 'spine') pkg.tocId = attrs.toc ?? '';
      else if (name === 'itemref' && attrs.idref) pkg.spine.push(attrs.idref);
    },
    close(name) {
      if (name === 'metadata') inMetadata = false;
      if (capture && name === capture) {
        const v = buf.replace(/\s+/g, ' ').trim();
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
  if (!pkg.coverId) {
    for (const it of pkg.items.values()) if (/\bcover-image\b/.test(it.props)) pkg.coverId = it.id;
  }
  return pkg;
}

// Font obfuscation (IDPF and Adobe): only embedded fonts are scrambled, the text is readable.
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);
const DRM_MESSAGE = 'This book is copy-protected (DRM), so it can only be read in the app of the store it came from.';
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
 * producing pages of scrambled bytes: Adobe ADEPT (rights.xml), Apple
 * FairPlay (sinf.xml), Readium LCP (license.lcpl), or any encryption of the
 * text itself. Books whose only "encryption" is font obfuscation are fine.
 */
function checkDrm(zip: ZipArchive, encrypted: string[], pkg?: Package) {
  if (zip.find('META-INF/rights.xml') || zip.find('META-INF/sinf.xml') || zip.find('META-INF/license.lcpl')) {
    throw new BookError(DRM_MESSAGE);
  }
  if (!encrypted.length) return;
  const content = new Set<string>();
  if (pkg) {
    for (const id of pkg.spine) {
      const it = pkg.items.get(id);
      if (it) content.add(it.href.toLowerCase());
    }
  }
  if (encrypted.some((p) => CONTENT_FILE.test(p) || content.has(p.toLowerCase()))) throw new BookError(DRM_MESSAGE);
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
        else if (/\btoc\b/.test(attrs['epub:type'] ?? attrs.type ?? attrs.role ?? '')) inToc = 1;
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
        link.t = link.t.replace(/\s+/g, ' ').trim();
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
        const t = label.replace(/\s+/g, ' ').trim();
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

export async function ingestEpub(ctx: IngestContext, zip: ZipArchive): Promise<Manifest> {
  // Checked before the package too: an encrypted package can't be parsed.
  const encrypted = encryptedFiles(zip);
  checkDrm(zip, encrypted);
  const opfPath = readContainer(zip);
  const pkg = readPackage(zip, opfPath);
  checkDrm(zip, encrypted, pkg);

  let rawToc: RawToc[] = [];
  const navItem = [...pkg.items.values()].find((i) => /\bnav\b/.test(i.props));
  if (navItem) rawToc = readNav(zip, navItem);
  if (!rawToc.length) {
    const ncx = pkg.items.get(pkg.tocId) ?? [...pkg.items.values()].find((i) => i.type === 'application/x-dtbncx+xml');
    if (ncx) rawToc = readNcx(zip, ncx);
  }

  // Which ids in which files the TOC points at.
  const wanted = new Map<string, Set<string>>();
  for (const t of rawToc) {
    const f = fragmentOf(t.href);
    if (!f) continue;
    const path = t.href.slice(0, t.href.indexOf('#'));
    if (!wanted.has(path)) wanted.set(path, new Set());
    wanted.get(path)!.add(f);
  }

  const w = new BookWriter(ctx.sink);
  const images: Record<string, ImageRef> = {};

  let cover: string | undefined;
  let coverFile: string | undefined;
  const coverItem = pkg.items.get(pkg.coverId);
  if (coverItem && /^image\//.test(coverItem.type)) {
    const ce = zip.find(coverItem.href);
    if (ce) {
      const name = 'cover.' + extOf(coverItem.href, coverItem.type);
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

  const fileStart = new Map<string, number>();
  const anchorBlock = new Map<string, number>();
  // Footnotes: every internal link seen so far, and where linked ids start/end.
  const linkKeys = new Set<string>();
  const notes: Record<string, [number, number]> = {};

  const spine = pkg.spine.map((id) => pkg.items.get(id)).filter((i): i is ManifestItem => !!i);
  const entries = spine.map((i) => zip.find(i.href));
  const totalBytes = entries.reduce((a, e) => a + (e?.compressedSize ?? 0), 0) || 1;
  let doneBytes = 0;

  for (let si = 0; si < spine.length; si++) {
    const item = spine[si];
    const entry = entries[si];
    if (!entry) continue;
    w.chapterBreak();
    fileStart.set(item.href, w.blockIndex);
    const anchors = wanted.get(item.href);
    const html = new HtmlToBlocks(w, {
      anchors,
      link: (href) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null; // http:, mailto:, ...
        const frag = fragmentOf(href);
        const path = href.startsWith('#') ? item.href : resolvePath(item.href, href);
        const key = frag ? `${path}#${frag}` : path;
        linkKeys.add(key);
        return key;
      },
      onIdStart: (id, b) => {
        const key = `${item.href}#${id}`;
        if (!linkKeys.has(key) || notes[key]) return false;
        notes[key] = [b, b];
        return true;
      },
      onIdEnd: (id, b) => {
        const n = notes[`${item.href}#${id}`];
        if (n) n[1] = Math.max(n[1], b);
      },
      onAnchor: (id, b) => {
        const key = item.href + '#' + id;
        if (!anchorBlock.has(key)) anchorBlock.set(key, b);
      },
      image: (src) => {
        if (/^(https?:|data:)/i.test(src)) return null;
        const path = resolvePath(item.href, src);
        if (!images[path]) {
          const ie = zip.find(path);
          if (!ie) return null;
          images[path] = { zip: [ie.offset, ie.compressedSize, ie.size, ie.method], ext: extOf(path) };
        }
        return path;
      },
    });
    const tok = new MarkupTokenizer(html);
    let decoder: StreamDecoder | null = null;
    await zip.stream(
      entry,
      (bytes) => {
        if (!decoder) {
          const bom = detectBom(bytes);
          decoder = createDecoder(bom?.enc ?? xmlDeclaredEncoding(bytes) ?? 'utf-8');
          if (bom) bytes = bytes.subarray(bom.skip);
        }
        tok.feed(decoder.decode(bytes));
      },
      async (f) => {
        ctx.progress((doneBytes + f * entry.compressedSize) / totalBytes);
        await ctx.pause();
      },
    );
    if (decoder) tok.feed((decoder as StreamDecoder).end());
    tok.end();
    html.finish();
    doneBytes += entry.compressedSize;
  }
  w.finish();

  // Links to whole chapters point at the chapter's first block.
  for (const key of linkKeys) {
    if (!notes[key] && !key.includes('#') && fileStart.has(key)) {
      const b = fileStart.get(key)!;
      notes[key] = [b, b + 1];
    }
  }

  let toc: TocEntry[] = [];
  for (const t of rawToc) {
    const hash = t.href.indexOf('#');
    const path = hash >= 0 ? t.href.slice(0, hash) : t.href;
    const b = hash >= 0 ? anchorBlock.get(`${path}#${fragmentOf(t.href)}`) ?? fileStart.get(path) : fileStart.get(path);
    if (b !== undefined && b < w.totalBlocks) toc.push({ t: t.t, l: t.l, b });
  }
  if (!toc.length) toc = w.headings;

  return {
    v: 1,
    format: 'epub',
    title: pkg.title || ctx.fallbackTitle,
    author: pkg.authors.join(', '),
    lang: pkg.lang || undefined,
    totalBlocks: w.totalBlocks,
    totalChars: w.totalChars,
    chunks: w.chunks,
    toc,
    images,
    cover,
    notes,
  };
}

