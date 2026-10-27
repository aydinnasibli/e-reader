// Long work on the JS thread done in the background (a chunk's HTML with its
// hyphenation, a big picture taken out of the book, ahead of the reader) in
// pieces, with a pause between them for the app to draw and answer touches.
// Not for what's wanted on screen: a pause is a timer, and timers fire on the
// next frame (Android) or later, so work in pieces takes twice as long or
// more. (setImmediate is no pause: it runs before anything else does.)

/**
 * The timer as the app started with it: a pause is a real one even where a
 * test has put fake timers in place (which would wait for it forever).
 */
const pauseTimer = globalThis.setTimeout;

/** How long a piece of work may run before the app gets a turn: about a frame. */
const SLICE_MS = 16;

export type Breather = () => Promise<void>;

/** Awaited between pieces of work: a pause once the work has run SLICE_MS since the last one, unless it's wanted now (`hurry`). */
export function breather(hurry?: () => boolean): Breather {
  let since = Date.now();
  return async () => {
    if (Date.now() - since < SLICE_MS || hurry?.()) return;
    await new Promise<void>((r) => pauseTimer(r, 0));
    since = Date.now();
  };
}
