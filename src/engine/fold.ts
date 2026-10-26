// Text folded for matching what someone typed against a book, a title or a
// note: capitals, accents and the Turkish dotted and dotless i make no
// difference, so "kirmizi" finds "Kırmızı", "istanbul" finds "İstanbul" and
// "ILIK" finds "ılık". Every UTF-16 unit folds to exactly one unit, so a
// match's offsets in the folded text are its offsets in the original. Text
// is expected in composed form (NFC): the converter stores it that way.

const folded = new Map<string, string>();

function foldUnit(c: string): string {
  // Turkish: I/ı and İ/i are separate pairs; matching treats all four alike.
  if (c === 'I' || c === 'ı' || c === 'İ') return 'i';
  let f = folded.get(c);
  if (f === undefined) {
    // The letter without its accents (é → e, ş → s, ğ → g, ё → е), in lower case.
    const base = c.normalize('NFD')[0] ?? c;
    const lower = base.toLowerCase();
    f = lower.length === 1 ? lower : base;
    folded.set(c, f);
  }
  return f;
}

const FOLDABLE = /[A-Z\u0080-\uffff]/g;

/** `text` folded for matching; the same length as `text`. */
export function fold(text: string): string {
  return text.replace(FOLDABLE, foldUnit);
}
