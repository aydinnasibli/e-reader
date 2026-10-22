// Turns (X)HTML from EPUB chapters into blocks. Publisher CSS is ignored on
// purpose: the reader applies its own typography, which is what makes
// rendering fast and predictable regardless of how the book was produced.

import type { MarkupHandler } from './markup';
import { BOLD, type BlockKind, ITALIC, MONO, SUB, SUP } from './types';
import type { BookWriter } from './writer';

const SKIP = new Set(['head', 'script', 'style', 'title', 'noscript', 'template']);
const VOID = new Set(['img', 'br', 'hr', 'meta', 'link', 'input', 'col', 'area', 'base', 'wbr', 'source', 'image', 'embed', 'param', 'track']);
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'figure', 'figcaption',
  'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'address', 'center', 'body', 'html',
  'hgroup', 'details', 'summary', 'fieldset', 'legend', 'form', 'svg',
]);
const INLINE_STYLE: Record<string, number> = {
  b: BOLD, strong: BOLD, i: ITALIC, em: ITALIC, cite: ITALIC, var: ITALIC, dfn: ITALIC,
  code: MONO, tt: MONO, kbd: MONO, samp: MONO, sup: SUP, sub: SUB,
};

interface El {
  name: string;
  prevStyle: number;
  prevLink: string | undefined;
  block: boolean;
  /** An id someone links to; its end block is reported on close. */
  trackedId?: string;
}

export interface HtmlOptions {
  /** Map an image src to an image key, or null to drop it. */
  image(src: string): string | null;
  /** Element ids worth recording (TOC targets). */
  anchors?: Set<string>;
  onAnchor?(id: string, blockIndex: number): void;
  /** Resolve an <a href> to a link target key, or null for external links. */
  link?(href: string): string | null;
  /** An element with an id starts; return true to get onIdEnd for it. */
  onIdStart?(id: string, blockIndex: number): boolean;
  onIdEnd?(id: string, blockIndex: number): void;
}

export class HtmlToBlocks implements MarkupHandler {
  private stack: El[] = [];
  private skip = 0;
  private style = 0;
  private link: string | undefined;
  private headings: number[] = [];
  private pre = 0;
  private quote = 0;
  private lists: { ordered: boolean; n: number }[] = [];

  constructor(private w: BookWriter, private opts: HtmlOptions) {}

  open(name: string, attrs: Record<string, string>) {
    if (this.skip) {
      if (SKIP.has(name)) this.skip++;
      return;
    }
    if (SKIP.has(name)) {
      this.skip++;
      return;
    }
    const id = attrs.id ?? attrs.name;
    if (id && this.opts.anchors?.has(id)) this.opts.onAnchor?.(id, this.w.blockIndex);
    const tracked = id && this.opts.onIdStart?.(id, this.w.blockIndex) ? id : undefined;

    if (name === 'pagebreak') {
      // Mobipocket's <mbp:pagebreak/> separates chapters.
      this.w.chapterBreak();
      return;
    }
    if (name === 'img' || name === 'image') {
      const src = attrs.src ?? attrs['xlink:href'] ?? attrs.href ?? (attrs.recindex ? `recindex:${attrs.recindex}` : undefined);
      const key = src ? this.opts.image(src) : null;
      if (key) this.w.image(key);
      return;
    }
    if (name === 'br') {
      this.w.lineBreak();
      return;
    }
    if (name === 'hr') {
      this.w.separator();
      return;
    }
    if (VOID.has(name)) {
      if (tracked) this.opts.onIdEnd?.(tracked, this.w.blockIndex);
      return;
    }

    const block = BLOCK.has(name);
    this.stack.push({ name, prevStyle: this.style, prevLink: this.link, block, trackedId: tracked });
    if (name === 'a' && attrs.href) this.link = this.opts.link?.(attrs.href) ?? this.link;
    if (block) {
      this.w.endBlock();
      if (name.length === 2 && name[0] === 'h' && name[1] >= '1' && name[1] <= '6') this.headings.push(+name[1]);
      else if (name === 'pre') this.pre++;
      else if (name === 'blockquote') this.quote++;
      else if (name === 'ul' || name === 'ol') this.lists.push({ ordered: name === 'ol', n: 0 });
      this.applyKind();
      if (name === 'li') {
        const list = this.lists[this.lists.length - 1];
        if (list) this.w.text(list.ordered ? `${++list.n}. ` : '• ');
      }
    } else {
      let s = INLINE_STYLE[name] ?? 0;
      const css = attrs.style;
      if (css) {
        if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(css)) s |= BOLD;
        if (/font-style\s*:\s*italic/i.test(css)) s |= ITALIC;
      }
      this.style |= s;
    }
  }

  close(name: string) {
    if (this.skip) {
      if (SKIP.has(name)) this.skip--;
      return;
    }
    if (VOID.has(name)) return;
    // Tolerate unbalanced markup: close up to the nearest matching element, if any.
    let i = this.stack.length - 1;
    while (i >= 0 && this.stack[i].name !== name) i--;
    if (i < 0) return;
    while (this.stack.length > i) {
      const el = this.stack.pop()!;
      this.style = el.prevStyle;
      this.link = el.prevLink;
      if (el.block) {
        this.w.endBlock();
        const n = el.name;
        if (n.length === 2 && n[0] === 'h' && n[1] >= '1' && n[1] <= '6') this.headings.pop();
        else if (n === 'pre') this.pre--;
        else if (n === 'blockquote') this.quote--;
        else if (n === 'ul' || n === 'ol') this.lists.pop();
        this.applyKind();
      }
      if (el.trackedId) this.opts.onIdEnd?.(el.trackedId, this.w.blockIndex);
    }
  }

  text(t: string) {
    if (!this.skip) this.w.text(t, this.style, this.link);
  }

  /** Close everything at the end of a chapter. */
  finish() {
    this.w.endBlock();
    this.stack = [];
    this.style = 0;
    this.link = undefined;
    this.headings = [];
    this.pre = this.quote = 0;
    this.lists = [];
    this.skip = 0;
    this.w.setKind('p');
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
  }
}
