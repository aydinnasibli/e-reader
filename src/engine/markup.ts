// A small, forgiving, streaming XML/HTML tokenizer. Feed it string slices of
// any size; it emits tags and text as soon as they are complete. It never
// builds a DOM, so a 100 MB chapter costs no more memory than a 100 KB one.
// Malformed markup (common in ebooks) degrades to text instead of throwing.

import { record } from './types';

export interface MarkupHandler {
  open(name: string, attrs: Record<string, string>, selfClosing: boolean): void;
  close(name: string): void;
  text(text: string): void;
  /** The content of a <style> or <script> element, as is (no tags, no entities), in pieces. */
  raw?(text: string): void;
}

// The HTML 4 named entities (as HTML5 decodes them), and a few later ones
// ebooks use. Names are case-sensitive: &Omega; is Ω, &omega; is ω. (A Map:
// "&constructor;" in a book is text, not something every object has.)
const ENTITIES = new Map<string, string>();
// Latin-1: &nbsp; to &yuml; are U+00A0..U+00FF in order.
'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'
  .split(' ')
  .forEach((name, i) => ENTITIES.set(name, String.fromCharCode(0xa0 + i)));
// Greek: &Alpha; to &Omega; and &alpha; to &omega; follow the Unicode order (there's no capital final sigma).
'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho - Sigma Tau Upsilon Phi Chi Psi Omega'
  .split(' ')
  .forEach((name, i) => {
    if (name === '-') return;
    ENTITIES.set(name, String.fromCharCode(0x391 + i));
    ENTITIES.set(name.toLowerCase(), String.fromCharCode(0x3b1 + i));
  });
for (const pair of (
  'quot:22 amp:26 apos:27 lt:3c gt:3e QUOT:22 AMP:26 LT:3c GT:3e COPY:a9 REG:ae ' +
  'OElig:152 oelig:153 Scaron:160 scaron:161 Yuml:178 fnof:192 circ:2c6 tilde:2dc sigmaf:3c2 thetasym:3d1 upsih:3d2 piv:3d6 ' +
  'ensp:2002 emsp:2003 thinsp:2009 hairsp:200a ZeroWidthSpace:200b zwnj:200c zwj:200d lrm:200e rlm:200f hyphen:2010 ' +
  'ndash:2013 mdash:2014 horbar:2015 lsquo:2018 rsquo:2019 sbquo:201a ldquo:201c rdquo:201d bdquo:201e dagger:2020 Dagger:2021 ' +
  'bull:2022 hellip:2026 permil:2030 prime:2032 Prime:2033 lsaquo:2039 rsaquo:203a oline:203e frasl:2044 euro:20ac ' +
  'image:2111 weierp:2118 real:211c trade:2122 alefsym:2135 frac13:2153 frac23:2154 frac15:2155 frac16:2159 frac18:215b ' +
  'frac38:215c frac58:215d frac78:215e larr:2190 uarr:2191 rarr:2192 darr:2193 harr:2194 crarr:21b5 lArr:21d0 uArr:21d1 ' +
  'rArr:21d2 dArr:21d3 hArr:21d4 forall:2200 part:2202 exist:2203 empty:2205 nabla:2207 isin:2208 notin:2209 ni:220b ' +
  'prod:220f sum:2211 minus:2212 lowast:2217 radic:221a prop:221d infin:221e ang:2220 and:2227 or:2228 cap:2229 cup:222a ' +
  'int:222b there4:2234 sim:223c cong:2245 asymp:2248 ne:2260 equiv:2261 le:2264 ge:2265 sub:2282 sup:2283 nsub:2284 ' +
  'sube:2286 supe:2287 oplus:2295 otimes:2297 perp:22a5 sdot:22c5 lceil:2308 rceil:2309 lfloor:230a rfloor:230b ' +
  'lang:27e8 rang:27e9 loz:25ca spades:2660 clubs:2663 hearts:2665 diams:2666'
).split(' ')) {
  const [name, hex] = pair.split(':');
  ENTITIES.set(name, String.fromCharCode(parseInt(hex, 16)));
}

// &#128; to &#159; name the windows-1252 characters there, as old HTML meant them (&#150; is an en dash).
const C1 = '20ac 81 201a 192 201e 2026 2020 2021 2c6 2030 160 2039 152 8d 17d 8f 90 2018 2019 201c 201d 2022 2013 2014 2dc 2122 161 203a 153 9d 17e 178'
  .split(' ')
  .map((h) => parseInt(h, 16));

const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;

export function decodeEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(ENTITY_RE, (m, e: string) => {
    if (e[0] === '#') {
      let cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (cp >= 0x80 && cp <= 0x9f) cp = C1[cp - 0x80];
      if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd';
      return String.fromCodePoint(cp);
    }
    return ENTITIES.get(e) ?? m;
  });
}

const ATTR_RE = /([^\s=/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
/** Elements whose content is raw text that must not be tokenized: HTML's (FB2 has none, its <style> holds text). */
const HTML_RAW_TEXT: ReadonlySet<string> = new Set(['script', 'style']);
// Tags longer than this (an image embedded as a data: URI, a huge SVG path)
// aren't buffered: the tag is skipped up to its closing '>'.
const MAX_TAG = 64 * 1024;

function localName(qname: string): string {
  const i = qname.indexOf(':');
  return (i >= 0 ? qname.slice(i + 1) : qname).toLowerCase();
}

export class MarkupTokenizer {
  private buf = '';
  private pos = 0;
  /** Inside <script>/<style>: matches its closing tag (any case, optional namespace prefix). */
  private raw: RegExp | null = null;
  /** Skipping an oversized tag: the quote character we're inside, or 0. */
  private skipping: number | null = null;
  /**
   * Inside a comment, CDATA section or declaration: what ends it, and whether
   * its content is text. Searched for as the input arrives, so one that never
   * ends costs no more than reading past it.
   */
  private until: { end: string; text: boolean } | null = null;

  /** `rawText`: the elements whose content isn't markup (see HTML_RAW_TEXT). */
  constructor(
    private h: MarkupHandler,
    private rawText: ReadonlySet<string> = HTML_RAW_TEXT,
  ) {}

  feed(chunk: string) {
    this.buf = this.pos < this.buf.length ? this.buf.slice(this.pos) + chunk : chunk;
    this.pos = 0;
    this.run(false);
  }

  end() {
    this.run(true);
    this.buf = '';
    this.pos = 0;
  }

  private emitText(s: string) {
    if (s.length) this.h.text(decodeEntities(s));
  }

  private run(final: boolean) {
    const buf = this.buf;
    const len = buf.length;
    let pos = this.pos;
    while (pos < len) {
      if (this.raw) {
        // Searched in place: lowercasing the buffer can change its length (Turkish İ).
        this.raw.lastIndex = pos;
        const close = this.raw.exec(buf);
        // Keep enough to see a closing tag cut in half by the next chunk.
        const stop = close ? close.index : final ? len : Math.max(pos, len - 64);
        if (stop > pos) this.h.raw?.(buf.slice(pos, stop));
        pos = stop;
        if (!close) break;
        this.raw = null;
        continue;
      }
      if (this.until) {
        const { end, text } = this.until;
        const at = buf.indexOf(end, pos);
        // Keep what could be the start of the end marker cut off by the next chunk.
        const stop = at >= 0 ? at : final ? len : Math.max(pos, len - end.length + 1);
        if (text && stop > pos) this.h.text(buf.slice(pos, stop));
        pos = stop;
        if (at < 0) break;
        pos += end.length;
        this.until = null;
        continue;
      }
      if (this.skipping !== null) {
        let quote = this.skipping;
        let i = pos;
        for (; i < len; i++) {
          const c = buf.charCodeAt(i);
          if (quote) {
            if (c === quote) quote = 0;
          } else if (c === 34 || c === 39) quote = c;
          else if (c === 62 /* > */) break;
        }
        if (i === len) {
          this.skipping = quote;
          pos = len;
          break;
        }
        this.skipping = null;
        pos = i + 1;
        continue;
      }
      const lt = buf.indexOf('<', pos);
      if (lt === -1) {
        if (final) {
          this.emitText(buf.slice(pos));
          pos = len;
        } else {
          // Hold back a possibly cut-off entity like "&mda".
          let cut = len;
          const amp = buf.lastIndexOf('&');
          if (amp >= pos && len - amp < 12 && buf.indexOf(';', amp) === -1) cut = amp;
          this.emitText(buf.slice(pos, cut));
          pos = cut;
        }
        break;
      }
      if (lt > pos) {
        this.emitText(buf.slice(pos, lt));
        pos = lt;
      }
      if (pos + 1 >= len) {
        if (final) {
          this.h.text('<');
          pos = len;
        }
        break;
      }
      const next = buf.charCodeAt(pos + 1);
      if (next === 33 /* ! */ || next === 63 /* ? */) {
        // Wait for enough input to tell a comment or CDATA section from other declarations.
        if (!final && len - pos < 9 && ('<!--'.startsWith(buf.slice(pos, pos + 4)) || '<![CDATA['.startsWith(buf.slice(pos)))) break;
        if (buf.startsWith('<!--', pos)) {
          this.until = { end: '-->', text: false };
          pos += 4;
        } else if (buf.startsWith('<![CDATA[', pos)) {
          this.until = { end: ']]>', text: true };
          pos += 9;
        } else {
          // <!DOCTYPE ...>, <?xml ...?>
          this.until = { end: '>', text: false };
          pos += 2;
        }
        continue;
      }
      const isTagStart = next === 47 /* / */ || (next >= 65 && next <= 90) || (next >= 97 && next <= 122) || next === 95 || next > 127;
      if (!isTagStart) {
        this.h.text('<');
        pos++;
        continue;
      }
      const end = findTagEnd(buf, pos + 1);
      if (end === -2) {
        this.h.text('<');
        pos++;
        continue;
      }
      if (end === -1) {
        if (final) {
          this.h.text('<');
          pos++;
          continue;
        }
        if (len - pos > MAX_TAG) {
          this.skipping = 0;
          pos++;
          continue;
        }
        break;
      }
      this.tag(buf.slice(pos + 1, end));
      pos = end + 1;
    }
    this.pos = pos;
  }

  private tag(inner: string) {
    if (inner[0] === '/') {
      const name = localName(inner.slice(1).trim().split(/\s/)[0] ?? '');
      if (name) this.h.close(name);
      return;
    }
    let selfClosing = false;
    if (inner.endsWith('/')) {
      selfClosing = true;
      inner = inner.slice(0, -1);
    }
    const m = /^[^\s/>]+/.exec(inner);
    if (!m) return;
    const name = localName(m[0]);
    const attrs = record<string>();
    const rest = inner.slice(m[0].length);
    if (rest.trim()) {
      ATTR_RE.lastIndex = 0;
      let a: RegExpExecArray | null;
      while ((a = ATTR_RE.exec(rest))) {
        attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
      }
    }
    this.h.open(name, attrs, selfClosing);
    if (selfClosing) this.h.close(name);
    else if (this.rawText.has(name)) this.raw = new RegExp(`</(?:[^\\s>/:]+:)?${name}(?=[\\s>/])`, 'gi');
  }
}

/** Index of the '>' closing the tag, -1 if not buffered yet, -2 if it isn't a tag. */
function findTagEnd(buf: string, from: number): number {
  let quote = 0;
  for (let i = from; i < buf.length; i++) {
    const c = buf.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 62 /* > */) {
      return i;
    } else if (c === 60 /* < */) {
      // A new tag started before this one closed: the '<' we saw was text.
      return -2;
    }
  }
  return -1;
}
