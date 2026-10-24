// How wide each character is in the reader's fonts, measured by the phone's
// own text engine. React Native can't say where a character is drawn, only
// how wide each laid-out line is; a hidden text with one character per line
// (see CharProbe) gives the widths, and positions along a line follow from
// them. Until a character is measured, an estimate stands in.
//
// Whole words are measured too, when a selection needs them: letters drawn
// together are tucked closer than their widths add up to (kerning, "fi"
// ligatures), and a selection handle placed by letter widths alone drifts
// sideways along the line.

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
/** Measured word widths at PROBE_SIZE, per face; NaN: couldn't be measured. */
const knownWords = new Map<string, Map<string, number>>();
/** Characters and words waiting to be measured, per face. */
const wanted = new Map<string, { face: Face; chars: Set<string>; words: Set<string> }>();

/** Words worth measuring: more than one character, measurable, short enough not to wrap in the probe. */
const measurableWord = (w: string) => w.length > 1 && w.length <= 40 && !/\s/.test(w) && [...w].every(measurable);
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

function wantedFor(face: Face, key: string) {
  let w = wanted.get(key);
  if (!w) wanted.set(key, (w = { face, chars: new Set(), words: new Set() }));
  return w;
}

function want(face: Face, key: string, ch: string) {
  const w = wantedFor(face, key);
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

/**
 * Width of `word` (no spaces) drawn in `face` at `size`, as the text engine
 * lays it out; undefined until measured (it's asked for) or if it can't be.
 */
export function wordWidth(face: Face, word: string, size: number): number | undefined {
  const key = faceKey(face);
  const w = knownWords.get(key)?.get(word);
  if (w !== undefined) return Number.isNaN(w) ? undefined : (w * size) / PROBE_SIZE;
  if (!measurableWord(word)) return undefined;
  const pending = wantedFor(face, key);
  if (!pending.words.has(word)) {
    pending.words.add(word);
    changed();
  }
  return undefined;
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
export function wantedWidths(): { key: string; face: Face; chars: string[]; words: string[] }[] {
  return [...wanted].filter(([, w]) => w.chars.size || w.words.size).map(([key, w]) => ({ key, face: w.face, chars: [...w.chars], words: [...w.words] }));
}

/**
 * The probe laid out `chars` and `words` (a line of bars first, then one line
 * per character, then one per word) and the lines came out this wide. Null
 * widths: they couldn't be measured, so estimates stay (and aren't asked for again).
 */
export function recordWidths(key: string, chars: string[], lineWidths: number[] | null, words: string[] = []) {
  let have = known.get(key);
  if (!have) known.set(key, (have = new Map()));
  let haveWords = knownWords.get(key);
  if (!haveWords) knownWords.set(key, (haveWords = new Map()));
  const ok = lineWidths && lineWidths.length === chars.length + words.length + 1;
  chars.forEach((ch, i) => {
    const w = ok ? (lineWidths[i + 1] - lineWidths[0]) / PROBE_REPEAT : NaN;
    have.set(ch, Number.isFinite(w) && w >= 0 ? w : estimate(ch) * PROBE_SIZE);
  });
  words.forEach((word, i) => {
    const w = ok ? lineWidths[chars.length + i + 1] - lineWidths[0] : NaN;
    haveWords.set(word, Number.isFinite(w) && w > 0 ? w : NaN);
  });
  const w = wanted.get(key);
  if (w) {
    for (const ch of chars) w.chars.delete(ch);
    for (const word of words) w.words.delete(word);
  }
  changed();
}

/** The probe's text for these characters and words. */
export const probeText = (chars: string[], words: string[] = []) =>
  ['||', ...chars.map((c) => `|${c.repeat(PROBE_REPEAT)}|`), ...words.map((w) => `|${w}|`)].join('\n');

/** For tests: forget everything measured. */
export function resetWidths() {
  known.clear();
  knownWords.clear();
  wanted.clear();
}
