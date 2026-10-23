// How wide each character is in the reader's fonts, measured by the phone's
// own text engine. React Native can't say where a character is drawn, only
// how wide each laid-out line is; a hidden text with one character per line
// (see CharProbe) gives the widths, and positions along a line follow from
// them. Until a character is measured, an estimate stands in.

import type { TextStyle } from 'react-native';

/** Characters are measured at this size; widths scale with the font size. */
export const PROBE_SIZE = 64;
/** Each character is measured this many times in a row, between two bars. */
export const PROBE_REPEAT = 4;

export type Face = Pick<TextStyle, 'fontFamily' | 'fontWeight' | 'fontStyle'>;

export const faceKey = (f: Face) => `${f.fontFamily ?? ''}|${f.fontWeight ?? ''}|${f.fontStyle ?? ''}`;

/** Usual width of a character, in ems: for characters not measured (yet). */
export function estimate(ch: string): number {
  if (ch === '­' || ch === '\n') return 0; // soft hyphen: invisible unless the line breaks there
  if (ch === ' ') return 0.28;
  if (/[iljtfrI1.,;:'!|()[\]"`·]/.test(ch)) return 0.3;
  if (/[mwMW@%—]/.test(ch)) return 0.85;
  if (ch >= 'A' && ch <= 'Z') return 0.66;
  if (/[А-ЯЁ]/.test(ch)) return 0.68;
  return 0.52;
}

/** Characters a line of their own can measure (not line breaks, control characters or half of a pair). */
function measurable(ch: string) {
  const c = ch.charCodeAt(0);
  return c >= 0x20 && c !== 0x7f && c !== 0xad && c !== 0x2028 && c !== 0x2029 && (c < 0xd800 || c > 0xdfff);
}

/** Measured widths at PROBE_SIZE, per face. */
const known = new Map<string, Map<string, number>>();
/** Characters waiting to be measured, per face. */
const wanted = new Map<string, { face: Face; chars: Set<string> }>();
const listeners = new Set<() => void>();
let version = 0;
let scheduled = false;

function changed() {
  // Never notify during a render (widths are looked up while drawing).
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    version++;
    for (const l of listeners) l();
  }, 0);
}

function want(face: Face, key: string, ch: string) {
  let w = wanted.get(key);
  if (!w) wanted.set(key, (w = { face, chars: new Set() }));
  if (w.chars.has(ch)) return;
  w.chars.add(ch);
  changed();
}

/** Width of `ch` in `face` at `size`; asks for it to be measured if it isn't yet. */
export function charWidth(face: Face, ch: string, size: number): number {
  const key = faceKey(face);
  const w = known.get(key)?.get(ch);
  if (w !== undefined) return (w * size) / PROBE_SIZE;
  if (measurable(ch)) want(face, key, ch);
  return estimate(ch) * size;
}

/** Have every character of `text` measured in `face` (ahead of need). */
export function prepareWidths(face: Face, text: string) {
  const key = faceKey(face);
  const have = known.get(key);
  for (const ch of new Set(text)) if (!have?.has(ch) && measurable(ch)) want(face, key, ch);
}

// ---- for CharProbe ----

export function subscribeWidths(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export const widthsVersion = () => version;

/** What is waiting to be measured. */
export function wantedWidths(): { key: string; face: Face; chars: string[] }[] {
  return [...wanted].filter(([, w]) => w.chars.size).map(([key, w]) => ({ key, face: w.face, chars: [...w.chars] }));
}

/**
 * The probe laid out `chars` (a line of bars first, then one line per
 * character) and the lines came out this wide. Null widths: it couldn't be
 * measured, so the estimate stays (and isn't asked for again).
 */
export function recordWidths(key: string, chars: string[], lineWidths: number[] | null) {
  let have = known.get(key);
  if (!have) known.set(key, (have = new Map()));
  const ok = lineWidths && lineWidths.length === chars.length + 1;
  chars.forEach((ch, i) => {
    const w = ok ? (lineWidths[i + 1] - lineWidths[0]) / PROBE_REPEAT : NaN;
    have.set(ch, Number.isFinite(w) && w >= 0 ? w : estimate(ch) * PROBE_SIZE);
  });
  const w = wanted.get(key);
  if (w) for (const ch of chars) w.chars.delete(ch);
  changed();
}

/** The probe's text for these characters. */
export const probeText = (chars: string[]) => ['||', ...chars.map((c) => `|${c.repeat(PROBE_REPEAT)}|`)].join('\n');

/** For tests: forget everything measured. */
export function resetWidths() {
  known.clear();
  wanted.clear();
}
