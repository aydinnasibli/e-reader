// What Android's back button closes in the reader. Sheets and dialogs are
// modals and close themselves; these are the layers drawn over the page,
// closed one at a time, top first, before back leaves the book.

export type BackLayer = 'selection' | 'display' | 'highlight' | 'menu' | 'auto' | 'guide';

export interface Layers {
  /** Text selected on the page. */
  selection: boolean;
  display: boolean;
  highlighting: boolean;
  menu: boolean;
  auto: boolean;
  guide: boolean;
}

/** The layer back should close now, or null to leave the book. */
export function backLayer(l: Layers): BackLayer | null {
  if (l.selection) return 'selection';
  if (l.display) return 'display';
  if (l.highlighting) return 'highlight';
  if (l.menu) return 'menu';
  if (l.auto) return 'auto';
  if (l.guide) return 'guide';
  return null;
}
