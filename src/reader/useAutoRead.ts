// Auto page turn (page mode) and auto-scroll (scroll mode) on the reader
// screen: whether they run, at what speed, the turns they ask for and the
// time the page on screen is given, shown filling up in the auto bar.

import { useCallback, useEffect, useState } from 'react';
import type { Position } from '@/engine/types';
import type { ReaderSettings } from '@/lib/settings';
import { readingSpeed } from '@/lib/stats';
import { CHARS_PER_WORD, pageDelay, scrollSpeed } from './autoRead';
import type { BookData } from './book';

interface Options {
  id: string;
  book: BookData | null;
  settings: ReaderSettings;
  /** The place shown, and where the next page starts. */
  pos: Position;
  end: Position | undefined;
  /** Something is in front of the page (the menu, a sheet, a note, a selection, the highlighter): it waits. */
  covered: boolean;
  /** The window's width, for scroll mode's speed. */
  width: number;
}

export function useAutoRead({ id, book, settings, pos, end, covered, width }: Options) {
  // A tap in the middle of the page pauses it rather than opening the menu.
  const [auto, setAuto] = useState<{ running: boolean } | null>(null);
  // The end of the book: auto reading is over.
  const stopAuto = useCallback(() => setAuto(null), []);
  const pauseAuto = useCallback(() => setAuto({ running: false }), []);

  const autoWpm = settings.autoWpm || Math.max(60, Math.round(readingSpeed(id).cpm / CHARS_PER_WORD / 10) * 10);
  // Runs only while nothing else is in front of the page.
  const autoActive = !!auto?.running && !covered;

  const [turn, setTurn] = useState<{ dir: 1 | -1; n: number } | undefined>(undefined);
  // How long the page on screen stays, shown filling up in the auto bar (a
  // page takes its reading time, up to a minute or more: it must be seen working).
  const [pageTimer, setPageTimer] = useState<{ ms: number; n: number } | null>(null);
  /** How long the page on screen is read for (null: auto page turn isn't running). */
  const pageMs = (() => {
    if (!autoActive || settings.mode !== 'page' || !book) return null;
    const from = book.charOffset(pos);
    const to = end ? book.charOffset(end) : from + 1500;
    return { delay: pageDelay(Math.max(1, to - from), autoWpm), last: book.complete && to >= book.totalChars };
  })();
  const delay = pageMs?.delay ?? null;
  const lastPage = !!pageMs?.last;
  // The bar starts filling once a page: when a page comes (or its time changes), not when a turn is asked for.
  useEffect(() => {
    setPageTimer((p) => (delay === null ? null : { ms: delay, n: (p?.n ?? 0) + 1 }));
  }, [delay, pos, end]);
  useEffect(() => {
    if (delay === null) return;
    // The last page: stop when it's read.
    if (lastPage) {
      const t = setTimeout(() => setAuto(null), delay);
      return () => clearTimeout(t);
    }
    // Re-armed by every turn (and retried if a turn had to wait for text).
    const t = setTimeout(() => setTurn((x) => ({ dir: 1, n: (x?.n ?? 0) + 1 })), delay);
    return () => clearTimeout(t);
  }, [delay, lastPage, pos, end, turn]);
  const textWidth = width - settings.margin * 2;
  const autoScroll = autoActive && settings.mode === 'scroll' ? scrollSpeed(autoWpm, textWidth, settings.fontSize, Math.round(settings.fontSize * settings.lineSpacing)) : 0;

  return { auto, setAuto, stopAuto, pauseAuto, autoWpm, autoActive, turn, pageTimer, autoScroll };
}
