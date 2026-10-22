// A small, forgiving, streaming XML/HTML tokenizer. Feed it string slices of
// any size; it emits tags and text as soon as they are complete. It never
// builds a DOM, so a 100 MB chapter costs no more memory than a 100 KB one.
// Malformed markup (common in ebooks) degrades to text instead of throwing.

export interface MarkupHandler {
  open(name: string, attrs: Record<string, string>, selfClosing: boolean): void;
  close(name: string): void;
  text(text: string): void;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '­',
  mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
  bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', deg: '°',
  times: '×', divide: '÷', minus: '−', plusmn: '±', sect: '§', para: '¶',
  dagger: '†', Dagger: '‡', prime: '′', Prime: '″', thinsp: ' ', ensp: ' ',
  emsp: ' ', zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏', euro: '€',
  pound: '£', yen: '¥', cent: '¢', iexcl: '¡', iquest: '¿', frac12: '½',
  frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', acute: '´',
  uml: '¨', cedil: '¸', ordf: 'ª', ordm: 'º', not: '¬', micro: 'µ',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', loz: '◊',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å',
  aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ', ograve: 'ò',
  oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø', ugrave: 'ù',
  uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ', szlig: 'ß',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å',
  AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë',
  Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', Ntilde: 'Ñ', Ograve: 'Ò',
  Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø', Ugrave: 'Ù',
  Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', oelig: 'œ', OElig: 'Œ',
  scaron: 'š', Scaron: 'Š', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ',
  epsilon: 'ε', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', omega: 'ω',
};

const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;

export function decodeEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(ENTITY_RE, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!cp || cp > 0x10ffff) return '';
      return String.fromCodePoint(cp);
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}

const ATTR_RE = /([^\s=/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
// Elements whose content is raw text that must not be tokenized.
const RAW_TEXT = new Set(['script', 'style']);
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

  constructor(private h: MarkupHandler) {}

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
        if (!close) {
          // Keep enough to see a closing tag cut in half by the next chunk.
          pos = final ? len : Math.max(pos, len - 64);
          break;
        }
        pos = close.index;
        this.raw = null;
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
      if (next === 33 /* ! */) {
        if (buf.startsWith('<!--', pos)) {
          const end = buf.indexOf('-->', pos + 4);
          if (end === -1) {
            if (final) pos = len;
            break;
          }
          pos = end + 3;
          continue;
        }
        if (buf.startsWith('<![CDATA[', pos)) {
          const end = buf.indexOf(']]>', pos + 9);
          if (end === -1) {
            if (final) {
              this.h.text(buf.slice(pos + 9));
              pos = len;
            }
            break;
          }
          this.h.text(buf.slice(pos + 9, end));
          pos = end + 3;
          continue;
        }
      }
      if (next === 33 || next === 63 /* ? */) {
        const end = buf.indexOf('>', pos);
        if (end === -1) {
          if (final) pos = len;
          break;
        }
        pos = end + 1;
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
    const attrs: Record<string, string> = {};
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
    else if (RAW_TEXT.has(name)) this.raw = new RegExp(`</(?:[^\\s>/:]+:)?${name}(?=[\\s>/])`, 'gi');
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
