// Turns (X)HTML from EPUB chapters into blocks. Of the book's own CSS only
// the basics are kept (css.ts: italic, bold, small capitals, centred or
// right-aligned text, hidden text): the reader applies its own typography,
// which is what makes rendering fast and predictable however the book was
// produced.
//
// Tables can't be laid out as grids in reflowable text, so each row becomes
// one paragraph with its cells joined by a middle dot ("Name · Born · Died"),
// header cells in bold. Paragraphs and lists inside a cell stay in the row.
//
// Sloppy HTML is closed the way browsers close it: a new paragraph, list item
// or heading ends an open one, and an end tag for an element that isn't open
// is ignored at once instead of searched for.

import { type Declarations, EMPTY, PathIndex, type StyleSheet, type StyledElement, styleOf } from './css';
import type { MarkupHandler } from './markup';
import { BOLD, type BlockKind, ITALIC, MONO, type Position, SUB, SUP } from './types';
import type { BookWriter } from './writer';

const SKIP = new Set(['head', 'script', 'style', 'title', 'noscript', 'template', 'desc', 'metadata', 'annotation', 'annotation-xml']);
const VOID = new Set(['img', 'br', 'hr', 'meta', 'link', 'input', 'col', 'area', 'base', 'wbr', 'source', 'image', 'embed', 'param', 'track']);
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'figure', 'figcaption',
  'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'address', 'center', 'body', 'html',
  'hgroup', 'details', 'summary', 'fieldset', 'legend', 'form', 'svg',
]);
/** Table structure: never folded into a row (a nested table gets rows of its own). */
const TABLE_PARTS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);
/** Start tags that end an open paragraph (HTML's rule). */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset', 'figcaption',
  'figure', 'footer', 'header', 'hgroup', 'main', 'menu', 'nav', 'ol', 'p', 'section', 'summary', 'ul', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'pre', 'listing', 'form', 'li', 'dd', 'dt', 'table', 'hr', 'xmp',
]);
/** Elements an implied end never reaches past (a paragraph outside a table cell stays open inside it). */
const SCOPE = new Set(['table', 'td', 'th', 'caption', 'button', 'object', 'marquee', 'applet', 'template', 'html']);
const CELL_GAP = ' · ';
// (Maps where the key comes from the book: an element or type called "constructor" is nothing special.)
const INLINE_STYLE = new Map(Object.entries({
  b: BOLD, strong: BOLD, i: ITALIC, em: ITALIC, cite: ITALIC, var: ITALIC, dfn: ITALIC,
  code: MONO, tt: MONO, kbd: MONO, samp: MONO, sup: SUP, sub: SUB,
}));
// Text that already numbers its list item ("1. Wash", "(a)", "iv)") or bullets it.
const OWN_NUMBER = /^\s*\(?(\d{1,4}|[a-zA-Z]|[ivxlcdmIVXLCDM]{1,6})[.)]\s/;
const OWN_BULLET = /^\s*[•·●▪◦‣∙*–—-]\s/;

const NO_CLASSES: string[] = [];
const NOTE_CLASS = /\b(foot|end)?notes?\b|\bfn\b/i;
// Printed page numbers kept in the text (ebookmaker's, and the usual class names).
const PAGE_CLASS = /\b(x-ebookmaker-pageno|pageno|pagenum|page-?number|page-?break)\b/i;
/** The element as style sheets see it when there are none. */
const UNSTYLED: StyledElement = { name: '', classes: NO_CLASSES };
const isHeading = (n: string) => n.length === 2 && n[0] === 'h' && n[1] >= '1' && n[1] <= '6';

interface El {
  name: string;
  prevStyle: number;
  prevLink: string | undefined;
  prevAlign: 'c' | 'r' | undefined;
  block: boolean;
  /** An id someone links to; its end block is reported on close. */
  trackedId?: string;
  /** Table structure, or 'soft' for a block element folded into a table cell. */
  role?: 'table' | 'row' | 'cell' | 'soft';
  /** A link: where to, and what it says (to tell a note's mark from a reference to a chapter). */
  ref?: { key: string; text: string; mark: boolean };
  /** A printed page number: its text isn't the book's. */
  quiet?: boolean;
}

/** An open table. HTML lets rows and cells go unclosed, so they're closed implicitly. */
interface Table {
  row: boolean;
  /** The open cell's element name (td or th). */
  cell: string | null;
  /** The cell has no text yet: a separator goes before its first text if the row has some. */
  fresh: boolean;
}

interface List {
  ordered: boolean;
  /** The next item's number. */
  n: number;
  /** Counting down (<ol reversed>). */
  step: number;
  /** list-style-type: 'none', 'decimal', 'lower-alpha'... */
  type: string;
}

export interface HtmlOptions {
  /** Map an image src to an image key, or null to drop it. */
  image(src: string): string | null;
  /** The page space (lines) the picture with this key takes, if known. */
  imageLines?(key: string): number | undefined;
  /**
   * Every element id, with the block it's in (or starts) and, when it isn't
   * at the block's start, its exact place (BookWriter.mark).
   */
  onId?(id: string, blockIndex: number, place: Position | null): void;
  /** Resolve an <a href> to a link target key, or null for external links. */
  link?(href: string): string | null;
  /**
   * An element with an id starts; return true to get onIdEnd for it (a note
   * someone links to). `kind`: 'note' when the element says it's one (an
   * aside, a footnote by its type, role or class), 'place' when it's a
   * heading or in one (a chapter's start, never a note).
   */
  onIdStart?(id: string, blockIndex: number, kind?: 'note' | 'place'): boolean;
  /** A link ended; `mark`: it reads like a note's mark ("12", "[3]", "*", raised, or typed noteref). */
  onLinkEnd?(key: string, mark: boolean): void;
  onIdEnd?(id: string, blockIndex: number): void;
  /** The style sheet a <link rel="stylesheet"> names, or null. */
  stylesheet?(href: string): StyleSheet | null;
  /** Make a style sheet of a <style> element's text. */
  parseStyle?(css: string): StyleSheet;
}

function marker(n: number, type: string): string {
  switch (type) {
    case 'lower-alpha':
    case 'lower-latin':
    case 'upper-alpha':
    case 'upper-latin': {
      let s = '';
      for (let k = Math.max(1, n); k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s;
      return type.startsWith('upper') ? s.toUpperCase() : s;
    }
    case 'lower-roman':
    case 'upper-roman': {
      if (n < 1 || n > 3999) return String(n);
      let s = '';
      let k = n;
      for (const [v, r] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']] as const) {
        for (; k >= v; k -= v) s += r;
      }
      return type === 'upper-roman' ? s.toUpperCase() : s;
    }
    default:
      return String(n);
  }
}

const TYPE_ATTR = new Map(Object.entries({ '1': 'decimal', a: 'lower-alpha', A: 'upper-alpha', i: 'lower-roman', I: 'upper-roman' }));

export class HtmlToBlocks implements MarkupHandler {
  private stack: El[] = [];
  /** The open elements as the style sheets see them, parallel to `stack`, and what they have. */
  private path: StyledElement[] = [];
  private pathIndex = new PathIndex();
  /** How many of each element are open: an end tag for one that isn't is dropped at once. */
  private openCount = new Map<string, number>();
  /** Stack positions of open paragraphs, list items, dt/dd, headings, lists and scope boundaries. */
  private ps: number[] = [];
  private lis: number[] = [];
  private dds: number[] = [];
  private hs: number[] = [];
  private listEls: number[] = [];
  private scopes: number[] = [];
  private skip = 0;
  /** Inside an element hidden by the book's styles: its name and how deep in same-named ones. */
  private hidden: { name: string; depth: number } | null = null;
  /** Inside printed page numbers: their text is dropped, their ids are places to link to. */
  private quiet = 0;
  private style = 0;
  private link: string | undefined;
  private align: 'c' | 'r' | undefined;
  private headings: number[] = [];
  private pre = 0;
  private quote = 0;
  private lists: List[] = [];
  private tables: Table[] = [];
  /** A list item's number or bullet, written before its first text unless the text has its own. */
  private marker: { text: string; ordered: boolean } | null = null;
  /** The chapter's style sheets, in the order they apply. */
  private sheets: StyleSheet[] = [];
  /** Text of the <style> element being read. */
  private styleText: string | null = null;
  /** The link being read, if any. */
  private ref: El['ref'];

  constructor(private w: BookWriter, private opts: HtmlOptions) {}

  open(name: string, attrs: Record<string, string>, selfClosing = false) {
    if (this.hidden) {
      // (A self-closed one gets its close() call too.)
      if (name === this.hidden.name && (selfClosing || !VOID.has(name))) this.hidden.depth++;
      return;
    }
    // Style sheets live in the <head>, which is otherwise skipped.
    if (name === 'style') this.styleText = '';
    else if (name === 'link' && /\bstylesheet\b/i.test(attrs.rel ?? '') && attrs.href) {
      const sheet = this.opts.stylesheet?.(attrs.href);
      if (sheet && !sheet.empty) this.sheets.push(sheet);
    }
    // The body ends a head left open, as browsers end it: otherwise the whole chapter would be skipped with it.
    if (name === 'body') this.skip = 0;
    if (this.skip) {
      if (SKIP.has(name)) this.skip++;
      return;
    }
    if (SKIP.has(name)) {
      this.skip++;
      return;
    }
    let table = this.tables[this.tables.length - 1];
    // Inside a table cell, block elements (other than a nested table) are folded into the row.
    const soft = !!table?.cell && BLOCK.has(name) && !TABLE_PARTS.has(name);
    this.impliedEnds(name);
    table = this.tables[this.tables.length - 1];

    // (Only books with style sheets pay for matching them.)
    let styled = UNSTYLED;
    if (this.sheets.length) {
      const cls = attrs.class;
      styled = { name, id: attrs.id, classes: !cls ? NO_CLASSES : cls.indexOf(' ') < 0 ? [cls] : cls.split(/\s+/).filter(Boolean) };
    }
    const decl: Declarations = this.sheets.length || attrs.style ? styleOf(this.sheets, styled, this.path, attrs.style, this.pathIndex) : EMPTY;

    // Printed page numbers (EPUB 3 page breaks, ebookmaker's page numbers):
    // places to link to, never text or notes.
    const epubType = attrs['epub:type'] ?? '';
    const pageMark = epubType.includes('pagebreak') || attrs.role === 'doc-pagebreak' || (!!attrs.class && PAGE_CLASS.test(attrs.class));
    const id = attrs.id ?? attrs.name;
    // A block element starts a new block: close any loose text first, so an
    // anchor on it points at this block, not the text before it.
    if (id && BLOCK.has(name) && !soft && !(table && (name === 'td' || name === 'th'))) this.w.endBlock();
    const noteType = /\b(foot|end|rear)?notes?\b/.test(epubType) || /^doc-(foot|end)?note/.test(attrs.role ?? '');
    if (id) this.opts.onId?.(id, this.w.blockIndex, this.w.mark());
    const kind = noteType || name === 'aside' || NOTE_CLASS.test(attrs.class ?? '') ? 'note' : isHeading(name) || this.headings.length ? 'place' : undefined;
    const tracked = id && !pageMark && !this.quiet && this.opts.onIdStart?.(id, this.w.blockIndex, kind) ? id : undefined;

    // Hidden by the book's styles. A hidden note is kept: it's how some books
    // keep notes out of the text for pop-ups.
    if ((decl.hidden || attrs.hidden !== undefined) && !tracked && !noteType) {
      // (A self-closed one too: its close() follows and must close it, not an open one of the same name.)
      if (selfClosing || !VOID.has(name)) this.hidden = { name, depth: 1 };
      return;
    }

    if (name === 'pagebreak') {
      // Mobipocket's <mbp:pagebreak/> separates chapters.
      this.w.chapterBreak();
      return;
    }
    if (name === 'img' || name === 'image') {
      const src = attrs.src ?? attrs['xlink:href'] ?? attrs.href ?? (attrs.recindex ? `recindex:${attrs.recindex}` : undefined);
      const key = src ? this.opts.image(src) : null;
      if (key) this.w.image(key, this.opts.imageLines?.(key));
      return;
    }
    if (name === 'br' || name === 'hr') {
      if (table?.cell) this.w.text(' ');
      else if (name === 'br') this.w.lineBreak();
      else this.w.separator();
      return;
    }
    if (VOID.has(name)) {
      if (tracked) this.opts.onIdEnd?.(tracked, this.w.blockIndex);
      return;
    }

    if (table && (name === 'td' || name === 'th')) {
      if (table.cell) this.close(table.cell);
      this.push(this.quieted({ name, prevStyle: this.style, prevLink: this.link, prevAlign: this.align, block: false, trackedId: tracked, role: 'cell' }, pageMark), styled);
      table.cell = name;
      table.fresh = true;
      if (name === 'th') this.style |= BOLD;
      this.style = (this.style & ~decl.clear) | decl.set;
      return;
    }
    if (table && (name === 'tr' || name === 'thead' || name === 'tbody' || name === 'tfoot')) {
      if (table.cell) this.close(table.cell);
      if (table.row) this.close('tr');
    }
    if (soft) {
      this.push(this.quieted({ name, prevStyle: this.style, prevLink: this.link, prevAlign: this.align, block: false, trackedId: tracked, role: 'soft' }, pageMark), styled);
      if (isHeading(name)) this.style |= BOLD;
      this.style = (this.style & ~decl.clear) | decl.set;
      this.w.text(' ');
      return;
    }

    const block = BLOCK.has(name);
    const role = name === 'table' ? 'table' : name === 'tr' && table ? 'row' : undefined;
    const el = this.quieted({ name, prevStyle: this.style, prevLink: this.link, prevAlign: this.align, block, trackedId: tracked, role }, pageMark);
    this.push(el, styled);
    if (role === 'table') this.tables.push({ row: false, cell: null, fresh: false });
    else if (role === 'row') table.row = true;
    if (name === 'a' && attrs.href) {
      const key = this.opts.link?.(attrs.href);
      if (key) {
        this.link = key;
        el.ref = { key, text: '', mark: !!(this.style & SUP) || epubType.includes('noteref') || attrs.role === 'doc-noteref' };
        this.ref = el.ref;
      }
    }
    this.style = ((this.style | (INLINE_STYLE.get(name) ?? 0)) & ~decl.clear) | decl.set;
    if (block) {
      // Alignment is inherited by the blocks inside; left or justified undoes a centre.
      const own = name === 'center' ? 'c' : decl.align ?? alignAttr(attrs.align);
      if (own) this.align = own === 'l' ? undefined : own;
      this.w.endBlock();
      if (isHeading(name)) this.headings.push(+name[1]);
      else if (name === 'pre') this.pre++;
      else if (name === 'blockquote') this.quote++;
      else if (name === 'ul' || name === 'ol') this.lists.push(this.newList(name, attrs, decl));
      this.applyKind();
      if (name === 'li') this.startItem(attrs, decl);
    }
  }

  close(name: string) {
    if (this.hidden) {
      if (name === this.hidden.name && --this.hidden.depth === 0) this.hidden = null;
      return;
    }
    if (name === 'style' && this.styleText !== null) {
      if (this.styleText.trim() && this.opts.parseStyle) {
        const sheet = this.opts.parseStyle(this.styleText);
        if (!sheet.empty) this.sheets.push(sheet);
      }
      this.styleText = null;
    }
    if (this.skip) {
      if (SKIP.has(name)) this.skip--;
      return;
    }
    if (VOID.has(name)) return;
    // Any heading's end tag ends the open heading (<h2>…</h1>).
    if (isHeading(name) && !this.openCount.get(name)) {
      const h = this.hs[this.hs.length - 1];
      if (h !== undefined && h > this.top(this.scopes)) this.popTo(h);
      return;
    }
    // Tolerate unbalanced markup: close up to the nearest matching element, if any is open.
    if (!this.openCount.get(name)) {
      // A </p> with no paragraph open still ends one (HTML makes it an empty paragraph).
      if (name === 'p') this.w.endBlock();
      return;
    }
    let i = this.stack.length - 1;
    while (i >= 0 && this.stack[i].name !== name) i--;
    if (i >= 0) this.popTo(i);
  }

  text(t: string) {
    if (this.skip || this.hidden || this.quiet) return;
    const table = this.tables[this.tables.length - 1];
    if (table?.fresh && table.cell && /\S/.test(t)) {
      table.fresh = false;
      if (this.w.inBlock) this.w.text(CELL_GAP);
    }
    if (this.marker && /\S/.test(t)) {
      const m = this.marker;
      this.marker = null;
      if (!(m.ordered ? OWN_NUMBER : OWN_BULLET).test(t)) this.w.text(m.text);
    }
    const ref = this.ref;
    if (ref) {
      if (ref.text.length < 16) ref.text += t;
      if (this.style & SUP && /\S/.test(t)) ref.mark = true;
    }
    this.w.text(t, this.style, this.link);
  }

  raw(t: string) {
    if (this.styleText !== null && this.styleText.length < 512 * 1024) this.styleText += t;
  }

  /** Close everything at the end of a chapter. */
  finish() {
    this.w.endBlock();
    this.stack = [];
    this.path = [];
    this.pathIndex = new PathIndex();
    this.openCount.clear();
    this.ps = [];
    this.lis = [];
    this.dds = [];
    this.hs = [];
    this.listEls = [];
    this.scopes = [];
    this.style = 0;
    this.link = undefined;
    this.align = undefined;
    this.headings = [];
    this.pre = this.quote = 0;
    this.lists = [];
    this.tables = [];
    this.skip = 0;
    this.hidden = null;
    this.quiet = 0;
    this.marker = null;
    this.styleText = null;
    this.ref = undefined;
    this.w.setKind('p');
    this.w.setAlign(undefined);
  }

  private top(list: number[]) {
    return list.length ? list[list.length - 1] : -1;
  }

  /** HTML's implied end tags for a start tag `name`. */
  private impliedEnds(name: string) {
    const scope = this.top(this.scopes);
    if (name === 'li') {
      const li = this.top(this.lis);
      if (li > scope && li > this.top(this.listEls)) this.popTo(li);
    } else if (name === 'dt' || name === 'dd') {
      const dd = this.top(this.dds);
      if (dd > scope) this.popTo(dd);
    }
    if (CLOSES_P.has(name)) {
      const p = this.top(this.ps);
      if (p > this.top(this.scopes)) this.popTo(p);
    }
    // A heading can't hold another: <h2><h3> ends the h2.
    if (isHeading(name) && this.stack.length && isHeading(this.stack[this.stack.length - 1].name)) this.popTo(this.stack.length - 1);
  }

  /** `el`, marked as printed page numbers if it is. */
  private quieted(el: El, pageMark: boolean): El {
    if (pageMark) {
      el.quiet = true;
      this.quiet++;
    }
    return el;
  }

  private push(el: El, styled: StyledElement) {
    const at = this.stack.length;
    this.stack.push(el);
    this.path.push(styled);
    if (styled !== UNSTYLED) this.pathIndex.add(styled, 1);
    const n = el.name;
    this.openCount.set(n, (this.openCount.get(n) ?? 0) + 1);
    if (n === 'p') this.ps.push(at);
    else if (n === 'li') this.lis.push(at);
    else if (n === 'dt' || n === 'dd') this.dds.push(at);
    else if (isHeading(n)) this.hs.push(at);
    else if (n === 'ul' || n === 'ol') this.listEls.push(at);
    if (SCOPE.has(n)) this.scopes.push(at);
  }

  /** Close the element at stack position `i` and everything opened inside it. */
  private popTo(i: number) {
    while (this.stack.length > i) {
      const el = this.stack.pop()!;
      const styled = this.path.pop()!;
      if (styled !== UNSTYLED) this.pathIndex.add(styled, -1);
      const n = el.name;
      this.openCount.set(n, (this.openCount.get(n) ?? 1) - 1);
      const at = this.stack.length;
      if (n === 'p') dropTop(this.ps, at);
      else if (n === 'li') dropTop(this.lis, at);
      else if (n === 'dt' || n === 'dd') dropTop(this.dds, at);
      else if (isHeading(n)) dropTop(this.hs, at);
      else if (n === 'ul' || n === 'ol') dropTop(this.listEls, at);
      if (SCOPE.has(n)) dropTop(this.scopes, at);
      this.style = el.prevStyle;
      this.link = el.prevLink;
      this.align = el.prevAlign;
      if (el.role) {
        // Inner tables are popped first, so the top table is the one this element belongs to.
        const table = this.tables[this.tables.length - 1];
        if (el.role === 'table') this.tables.pop();
        else if (el.role === 'soft') this.w.text(' ');
        else if (table && el.role === 'cell') table.cell = null;
        else if (table && el.role === 'row') table.row = false;
      }
      if (el.block) {
        this.w.endBlock();
        if (isHeading(n)) this.headings.pop();
        else if (n === 'pre') this.pre--;
        else if (n === 'blockquote') this.quote--;
        else if (n === 'ul' || n === 'ol') this.lists.pop();
        else if (n === 'li') this.marker = null;
        this.applyKind();
      }
      if (el.trackedId) this.opts.onIdEnd?.(el.trackedId, this.w.blockIndex);
      if (el.quiet) this.quiet--;
      if (el.ref) {
        const t = el.ref.text.trim();
        this.opts.onLinkEnd?.(el.ref.key, el.ref.mark || (t.length > 0 && t.length <= 5));
        this.ref = undefined;
      }
    }
  }

  private newList(name: string, attrs: Record<string, string>, decl: Declarations): List {
    const reversed = attrs.reversed !== undefined;
    const start = parseInt(attrs.start ?? '', 10);
    const type = decl.list ?? (name === 'ol' ? (TYPE_ATTR.get(attrs.type ?? '') ?? 'decimal') : 'disc');
    return { ordered: name === 'ol', n: Number.isFinite(start) ? start : 1, step: reversed && Number.isFinite(start) ? -1 : 1, type };
  }

  private startItem(attrs: Record<string, string>, decl: Declarations) {
    const list = this.lists[this.lists.length - 1];
    if (!list) return;
    const value = parseInt(attrs.value ?? '', 10);
    if (Number.isFinite(value)) list.n = value;
    const type = decl.list ?? list.type;
    const ordered = list.ordered && type !== 'disc' && type !== 'circle' && type !== 'square';
    if (type !== 'none') this.marker = { text: ordered ? `${marker(list.n, type)}. ` : '• ', ordered };
    if (list.ordered) list.n += list.step;
  }

  private applyKind() {
    let kind: BlockKind = 'p';
    let level = 0;
    if (this.pre) kind = 'pre';
    else if (this.headings.length) {
      kind = 'h';
      level = this.headings[this.headings.length - 1];
    } else if (this.quote) kind = 'q';
    this.w.setKind(kind, level);
    this.w.setAlign(this.align);
  }
}

function dropTop(list: number[], at: number) {
  if (list[list.length - 1] === at) list.pop();
}

/** The old align="center" attribute. */
function alignAttr(a: string | undefined): 'c' | 'r' | 'l' | undefined {
  const v = a?.trim().toLowerCase();
  return v === 'center' || v === 'middle' ? 'c' : v === 'right' ? 'r' : v === 'left' || v === 'justify' ? 'l' : undefined;
}
