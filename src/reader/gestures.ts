// How taps and swipes on a page are read. Pure, so the rules are tested.

/** Fraction of the screen width at each side that turns pages; the middle opens the menu. */
export const TAP_EDGE = 0.3;

export type TapZone = 'prev' | 'menu' | 'next';

/** Which zone a tap at `x` (screen coordinates) falls in. */
export function tapZone(x: number, width: number): TapZone {
  if (x < width * TAP_EDGE) return 'prev';
  if (x > width * (1 - TAP_EDGE)) return 'next';
  return 'menu';
}

/** Movement below this (points) is a tap that wobbled, not a swipe. */
export const TAP_SLOP = 24;

/**
 * What a horizontal drag that ended with movement `dx` and velocity `vx`
 * (points/ms) means. A swipe has to travel: a short, fast flick of a tapping
 * finger used to turn pages by accident.
 */
export function swipeOutcome(dx: number, vx: number, width: number): 'next' | 'prev' | 'tap' | 'none' {
  const dist = Math.abs(dx);
  if (dist < TAP_SLOP) return 'tap';
  const far = dist > Math.max(48, width * 0.12);
  const flick = dist >= 32 && Math.abs(vx) > 0.5 && Math.sign(vx) === Math.sign(dx);
  if (!far && !flick) return 'none';
  return dx < 0 ? 'next' : 'prev';
}
