// What the reader screen asks the page or scroll view about text on screen,
// to draw and drag selection handles.

import type { Caret } from './hitTest';
import type { TextPoint } from './selection';

export interface ReaderGeometry {
  /** The text under a point (window coordinates); the nearest text when between paragraphs. */
  pointAt(pageX: number, pageY: number): TextPoint | null;
  /** Where the caret before ('start') or after ('end') a character is, in window coordinates; null if not on screen. */
  caretAt(p: TextPoint, edge: 'start' | 'end'): Caret | null;
}
