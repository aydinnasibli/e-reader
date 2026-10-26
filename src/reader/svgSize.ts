// The size of an SVG picture, from its own markup: the phone's image loader
// (Image.getSize) can't open SVG files, though the reader's page shows them.
// Pure, so it's tested.

/** CSS lengths in an SVG's width and height, in pixels (relative ones can't be told here). */
const UNITS: Record<string, number> = { '': 1, px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, em: 16, ex: 8 };

function length(v: string | undefined): number | null {
  const m = v && /^\s*([\d.]+(?:e[-+]?\d+)?)\s*([a-z]*)\s*$/i.exec(v);
  if (!m) return null;
  const unit = UNITS[m[2].toLowerCase()];
  const n = Number(m[1]) * (unit ?? NaN);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Width and height of an SVG from the start of its file (its <svg> tag):
 * the width and height it gives, completed from its viewBox's proportions,
 * or the viewBox alone. Null if it says neither.
 */
export function svgSize(head: string): { width: number; height: number } | null {
  const tag = /<svg\b[^>]*>/i.exec(head)?.[0];
  if (!tag) return null;
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)?.slice(1).find((x) => x !== undefined);
  const box = attr('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const bw = box && box.length === 4 && box[2] > 0 ? box[2] : null;
  const bh = box && box.length === 4 && box[3] > 0 ? box[3] : null;
  let w = length(attr('width'));
  let h = length(attr('height'));
  if (w && !h && bw && bh) h = (w * bh) / bw;
  if (h && !w && bw && bh) w = (h * bw) / bh;
  if (!w || !h) {
    if (!bw || !bh) return null;
    w = bw;
    h = bh;
  }
  return { width: Math.round(w), height: Math.round(h) };
}
