// The browser's own text selection (a long press, then its handles), told to
// the screen once it settles: where it starts and ends in the book, and where
// on screen, for the menu over it.

import { send } from './bridge';
import { blockOf, carets, pointOf } from './text';

const SETTLE_MS = 120;

export function watchSelection() {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let shown = false;
  document.addEventListener('selectionchange', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const s = document.getSelection();
      const r = s && s.rangeCount > 0 && !s.isCollapsed ? s.getRangeAt(0) : null;
      const start = r && blockOf(r.startContainer) ? pointOf(r.startContainer, r.startOffset) : null;
      const end = r && blockOf(r.endContainer) ? pointOf(r.endContainer, r.endOffset) : null;
      const at = r ? carets(r) : null;
      if (r && start && end && at) {
        shown = true;
        send({ t: 'selection', start, end, startCaret: at.start, endCaret: at.end });
      } else if (shown) {
        shown = false;
        send({ t: 'noSelection' });
      }
    }, SETTLE_MS);
  });
}

export function clearSelection() {
  document.getSelection()?.removeAllRanges();
}
