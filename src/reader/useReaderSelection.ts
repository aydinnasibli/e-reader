// Text selected on the reader screen's page, and the highlight tool. A long
// press selects a word, with a menu to copy, look up, translate or share it,
// and handles at both ends to move it. The highlight tool (bottom menu) is a
// marker: a tap or a drag highlights, or takes highlighting away when it
// starts on a highlight. No selection.

import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Position, blockText } from '@/engine/types';
import type { ReaderSettings, Theme } from '@/lib/settings';
import { highlightColor } from '@/ui/theme';
import type { BookData } from './book';
import type { TextPoint } from './selection';
import { useSelection } from './useSelection';
import type { PageSelection, StrokeMark } from './web/WebReader';

interface Options {
  id: string;
  book: BookData | null;
  settings: ReaderSettings;
  theme: Theme;
  /** Bumped by every jump: the selection is left behind. */
  jumpKey: number;
  /** The place shown changed (see useReadingPlace). */
  onPosition(p: Position, e: Position | undefined, turned: boolean, turnedToLast: boolean): void;
  /** Text selected: the menu goes. */
  setChrome(shown: boolean): void;
}

export function useReaderSelection({ id, book, settings, theme, jumpKey, onPosition, setChrome }: Options) {
  const [highlighting, setHighlighting] = useState(false);
  const textOf = useCallback(
    (b: number) => {
      const blk = book?.block(b);
      return blk?.r ? blockText(blk) : null;
    },
    [book],
  );
  const selection = useSelection({
    bookId: id,
    bookTitle: book?.entry.title ?? '',
    textOf,
    // A long paragraph stored in parts: copied as the one paragraph it is.
    continues: (b) => !!book?.block(b)?.c,
    chapterOf: (b) => book?.chapterAt(b)?.t,
    color: settings.highlightColor,
  });
  const { sel, setSel } = selection;
  // A jump (contents, search, a note...) leaves the selection behind.
  useEffect(() => setSel(null), [jumpKey, setSel]);
  // The page selects text itself (the browser's own handles); the menu goes over its ends.
  const [selEnds, setSelEnds] = useState<Pick<PageSelection, 'start' | 'end'> | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  /** The text selected last told (a tick only when it changes, not each time the page says where it is now). */
  const tickedFor = useRef('');
  const onSelection = useCallback((s: PageSelection | null) => {
    const range = s ? `${s.a.b}:${s.a.o}-${s.z.b}:${s.z.o}` : '';
    if (s && range !== tickedFor.current) Haptics.selectionAsync().catch(() => {});
    tickedFor.current = range;
    setChrome(false);
    selectionRef.current.setSel(s ? { a: s.a, z: s.z } : null);
    setSelEnds(s ? { start: s.start, end: s.end } : null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (sel) return;
    setSelEnds(null);
    tickedFor.current = '';
  }, [sel]);
  // Scroll mode: the text scrolled under the selection, so its menu no longer
  // points at it; it shows again when the page tells where the selection is now.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onReaderPosition = useCallback(
    (p: Position, e: Position | undefined, turned: boolean, turnedToLast: boolean) => {
      if (turned && settingsRef.current.mode === 'scroll') setSelEnds(null);
      onPosition(p, e, turned, turnedToLast);
    },
    [onPosition],
  );
  // The highlight tool: a tap highlights the word tapped (or takes a highlight away), a drag what it covers.
  const onMarkTap = useCallback((p: TextPoint | null) => {
    if (p) selectionRef.current.markTap(p);
  }, []);
  const onMarkDrag = useCallback((from: TextPoint | null, to: TextPoint | null, done: boolean) => selectionRef.current.markDrag(from, to, done), []);
  const stopHighlighting = useCallback(() => {
    setHighlighting(false);
    selectionRef.current.endMarking();
  }, []);

  // A highlight tool drag as it goes, drawn over the marks (sent on its own): the new highlight, or the page showing through where it erases.
  const { stroke } = selection;
  const strokeMarks = useMemo<StrokeMark[] | null>(
    () => stroke && stroke.ranges.map((r) => ({ b: r.b, s: r.s, e: r.e, color: stroke.erase ? theme.bg : highlightColor(settings.highlightColor, theme.dark) })),
    [stroke, theme.bg, theme.dark, settings.highlightColor],
  );

  return { selection, sel, setSel, highlighting, setHighlighting, stopHighlighting, selEnds, onSelection, onReaderPosition, onMarkTap, onMarkDrag, strokeMarks };
}
