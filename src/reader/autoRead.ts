// Auto page turn / auto-scroll timing. Pure, so it's tested.

/** Characters per word, to talk about speed in words per minute. */
export const CHARS_PER_WORD = 6;
export const MIN_WPM = 60;
export const MAX_WPM = 1000;

/** Speed steps for the − / + buttons: about 10% each, rounded to 10 wpm. */
export function stepWpm(wpm: number, dir: 1 | -1): number {
  const next = Math.round((wpm * (dir > 0 ? 1.1 : 1 / 1.1)) / 10) * 10;
  const moved = next === wpm ? wpm + dir * 10 : next;
  return Math.min(MAX_WPM, Math.max(MIN_WPM, moved));
}

/** How long a page of `chars` characters stays before turning, in ms (at least 2 s). */
export function pageDelay(chars: number, wpm: number): number {
  return Math.max(2000, (chars / (wpm * CHARS_PER_WORD)) * 60_000);
}

/**
 * Scroll speed in points per second for a reading speed, from the text size:
 * characters per line (roughly half an em each) over the line height.
 */
export function scrollSpeed(wpm: number, textWidth: number, fontSize: number, lineHeight: number): number {
  const charsPerLine = Math.max(10, textWidth / (fontSize * 0.5));
  const charsPerSecond = (wpm * CHARS_PER_WORD) / 60;
  return (charsPerSecond / charsPerLine) * lineHeight;
}
