// The browser's own text selection (a long press, then its handles), told to
// the screen once it settles: where it starts and ends in the book, and where
// on screen, for the menu over it.

import { send } from './bridge';
import { carets, pointAround } from './text';

const SETTLE_MS = 120;

export function watchSelection() {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let shown = false;
  const tell = () => {
    const s = document.getSelection();
    const r = s && s.rangeCount > 0 && !s.isCollapsed ? s.getRangeAt(0) : null;
    // Its ends can be between blocks (a paragraph selected to its edge): the blocks' edges there.
    const start = r ? pointAround(r.startContainer, r.startOffset, false) : null;
    const end = r ? pointAround(r.endContainer, r.endOffset, true) : null;
    const at = r ? carets(r) : null;
    if (r && start && end && at && (start.b < end.b || (start.b === end.b && start.i < end.i))) {
      shown = true;
      send({ t: 'selection', start, end, startCaret: at.start, endCaret: at.end });
    } else if (shown) {
      shown = false;
      send({ t: 'noSelection' });
    }
  };
  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(tell, SETTLE_MS);
  };
  document.addEventListener('selectionchange', soon);
  // Scroll mode: the text moved under a selection (the screen hides its menu meanwhile): where it is now.
  window.addEventListener(
    'scroll',
    () => {
      if (shown) soon();
    },
    { passive: true },
  );
}

export function clearSelection() {
  document.getSelection()?.removeAllRanges();
}
