// Opening a screen from a tap. A second tap that lands before the new screen
// covers this one (a quick double tap) would open it twice: two readers, each
// keeping its page (a web view) in memory, and Back showing the same book
// again. So an opening right after another is ignored.

import { type Href, router } from 'expo-router';

/** How long after one opening another is taken for the same tap again. */
export const REPEAT_MS = 600;
let last = -Infinity;

/** router.push, unless a screen was opened less than REPEAT_MS ago. */
export function pushOnce(href: Href) {
  const now = Date.now();
  const since = now - last;
  // (A clock set back meanwhile doesn't keep anything from opening.)
  if (since >= 0 && since < REPEAT_MS) return;
  last = now;
  router.push(href);
}
