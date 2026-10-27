// The place read on the reader screen: where the page shows (`pos`, `end`),
// jumps to other places (`goTo`) and the chip back from them, saving the place
// and the reading time, and the book counted finished when it's read to its
// end.

import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { Position } from '@/engine/types';
import { getBook, updateBook } from '@/lib/library';
import { ReadingTracker } from '@/lib/stats';
import type { BookData } from './book';
import { finishesBook, storyEnd } from './finish';
import type { PageInfo } from './web/WebReader';

/** The place is saved a moment after it stops changing, and at least this often while it keeps changing (auto-scroll). */
const SAVE_DEBOUNCE_MS = 800;
const SAVE_EVERY_MS = 5000;

/**
 * The chip's way back: the place, page turns since, the page number the
 * footer showed there in its layout (the chip says the same while the
 * layout hasn't changed), and how far into its chunk the place is (for
 * the page it's on, in another layout).
 */
export type Back = { pos: Position; turns: number; shown?: { page: number; key: string }; f?: number };

interface Options {
  id: string;
  book: BookData | null;
  /** Bumped as the book grows or finishes converting. */
  version: number;
  startPos: Position;
  /** Where reading left off. */
  savedPos: Position;
  /** Opened at another place than where reading left off (a highlight): the way back is offered. */
  openedElsewhere: boolean;
  /** Auto page turn or auto-scroll is running (its time counts as reading at its pace). */
  autoRunning: RefObject<boolean>;
  /** The page numbers the reader reported last. */
  pageInfo: RefObject<PageInfo | null>;
  /** A jump was made: what was over the page (a sheet, the menu) goes. */
  onJump(): void;
}

export function useReadingPlace({ id, book, version, startPos, savedPos, openedElsewhere, autoRunning, pageInfo, onJump }: Options) {
  // Readers open at `latest`; bumping `jump.key` makes them jump there.
  const [jump, setJump] = useState<{ pos: Position; key: number; page?: number }>({ pos: startPos, key: 0 });
  const [pos, setPos] = useState<Position>(startPos);
  const [end, setEnd] = useState<Position | undefined>(undefined);
  const [searchMark, setSearchMark] = useState<{ b: number; s: number; e: number } | null>(null);
  const onJumpRef = useRef(onJump);
  onJumpRef.current = onJump;

  // The end of the book: its last page, or the back matter after the story,
  // reached by turning pages from the story (not by jumping there, e.g. to
  // read a note, and not by laying the same page out again). Marks the book finished.
  const storyEndBlock = useMemo(
    () => (book?.complete ? storyEnd(book.toc, (b) => book.chunks[book.chunkOf(b)]?.[1] ?? 0, book.totalChars) : null),
    [book, version], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const storyEndRef = useRef(storyEndBlock);
  storyEndRef.current = storyEndBlock;
  /** Where reading started since the last jump: the place the jump landed (or the book opened). */
  const runStart = useRef<Position | null>(null);
  const finishedHere = useRef(false);
  const [endChip, setEndChip] = useState(false);
  const markFinished = useCallback(() => {
    finishedHere.current = true;
    if (!getBook(id)?.finished) updateBook(id, { finished: true });
    setEndChip(true);
  }, [id]);
  // Once per visit: dismissing the chip at the end must not bring it back on every scroll.
  const reachEnd = useCallback(() => {
    if (!finishedHere.current) markFinished();
  }, [markFinished]);
  /** Reading since the last jump started in the story (not in notes jumped to). */
  const readingStory = useCallback(() => {
    const start = runStart.current?.b;
    const storyEnd = storyEndRef.current;
    return start !== undefined && (storyEnd === null || start < storyEnd);
  }, []);
  // Scroll mode: the end came into view while reading on from the story.
  const onScrolledToEnd = useCallback(() => {
    if (readingStory()) reachEnd();
  }, [readingStory, reachEnd]);

  // Reading time: page turns feed the tracker; jumps reset it.
  const tracker = useRef(new ReadingTracker(id)).current;
  /** A jump (or opening the book) whose place hasn't been read on from yet. */
  const jumped = useRef(true);

  // The place read is saved a moment after it stops changing, and when
  // leaving. After a jump (a highlight, a search result, the contents, a page
  // number) the saved place only moves once the reader reads on from where it
  // landed; leaving straight away keeps the place jumped from.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSave = useRef(0);
  const latest = useRef(startPos);
  /**
   * The place read before jumps not read on from yet, with its percent
   * (worked out while it was read: its chunk may be out of memory by the time
   * it's saved); null when the place read is where the reader is.
   */
  const jumpedFrom = useRef<{ pos: Position; percent?: number } | null>(openedElsewhere ? { pos: savedPos, percent: getBook(id)?.percent } : null);
  const save = useCallback(() => {
    if (!book) return;
    lastSave.current = Date.now();
    const kept = jumpedFrom.current;
    const place = kept?.pos ?? latest.current;
    // Still converting up to the saved place: its percent can't be worked out yet.
    if (!book.complete && place.b >= book.totalBlocks) return updateBook(id, { openedAt: Date.now() });
    const percent = kept ? kept.percent : book.fraction(place);
    updateBook(id, { position: place, ...(percent !== undefined ? { percent } : {}), openedAt: Date.now() });
  }, [book, id]);
  const [back, setBack] = useState<Back | null>(openedElsewhere ? { pos: savedPos, turns: 0 } : null);
  const onPosition = useCallback(
    (p: Position, e: Position | undefined, turned: boolean, turnedToLast: boolean) => {
      const prev = latest.current;
      latest.current = p;
      setPos(p);
      setEnd(e);
      if (book) {
        const ch = book.charOffset(p);
        if (!turned) {
          // A jump landing (or the page laid out again): reading starts here, once the reader reads on.
          if (jumped.current) {
            runStart.current = p;
            tracker.reset(ch);
          }
        } else {
          // Only reading on finishes a book: not a jump, nor the same page laid out again.
          const step = { runStart: runStart.current?.b ?? null, prev: prev.b, now: p.b, turnedToLast, storyEnd: storyEndRef.current };
          if (finishesBook(step)) reachEnd();
          if (autoRunning.current) tracker.autoTurn(ch);
          else tracker.turn(ch);
          jumped.current = false;
          // Read on from a jump: this is the place read now.
          jumpedFrom.current = null;
          setBack((bk) => (!bk ? bk : bk.turns >= 10 ? null : { ...bk, turns: bk.turns + 1 }));
        }
      }
      if (saveTimer.current) clearTimeout(saveTimer.current);
      // Saved at least every few seconds while the place keeps changing (auto-scroll reports it all the time).
      if (Date.now() - lastSave.current > SAVE_EVERY_MS) save();
      else saveTimer.current = setTimeout(save, SAVE_DEBOUNCE_MS);
    },
    [save, book, tracker, reachEnd], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    // Opening the book isn't a save: the first one waits for the place to change.
    lastSave.current = Date.now();
    const sub = AppState.addEventListener('change', (s) => {
      // Time in other apps (or with the screen locked) isn't reading.
      if (s !== 'active') {
        tracker.pause();
        save();
      } else tracker.resume();
    });
    return () => {
      sub.remove();
      if (saveTimer.current) clearTimeout(saveTimer.current);
      tracker.stop();
      save();
    };
  }, [save, tracker]);

  // "Back to where I was": the place before the last jump, until used,
  // dismissed, or read past (about ten page turns on). Opened at a highlight:
  // the way back to where reading left off. `shown` is the page number the
  // footer showed there, in its layout: the chip says the same while the
  // layout hasn't changed.
  /** Jump to `p` (with `page`, to that page by its number: the page mode reader lands on it exactly). */
  const goTo = useCallback(
    (p: Position, mark?: { s: number; e: number }, remember = true, page?: number) => {
      const info = pageInfo.current;
      const here = latest.current;
      if (remember) {
        setBack({ pos: here, turns: 0, shown: info ? { page: info.page, key: info.key } : undefined, f: book?.fractionInChunk(here) });
        // The place read stays where it was until the reader reads on from where this lands.
        jumpedFrom.current ??= { pos: here, percent: book?.fraction(here) };
      } else if (jumpedFrom.current && jumpedFrom.current.pos.b === p.b && jumpedFrom.current.pos.o === p.o) {
        // Back at the place read: it's where the reader is again (not so for a place only jumped to).
        jumpedFrom.current = null;
      }
      latest.current = p;
      jumped.current = true;
      setSearchMark(mark ? { b: p.b, ...mark } : null);
      setJump((j) => ({ pos: p, key: j.key + 1, page }));
      onJumpRef.current();
    },
    [book], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // The place the chip goes back to may be in a chunk not in memory (opened at a highlight):
  // read it, to tell the page it's on.
  const backAt = back && back.f === undefined ? back.pos : null;
  useEffect(() => {
    if (!backAt || !book) return;
    let alive = true;
    book.tryLoadChunk(book.chunkOf(backAt.b)).then(
      () => alive && setBack((bk) => (bk && bk.pos.b === backAt.b && bk.pos.o === backAt.o ? { ...bk, f: book.fractionInChunk(backAt) } : bk)),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [backAt?.b, backAt?.o, book]); // eslint-disable-line react-hooks/exhaustive-deps

  return { jump, pos, end, searchMark, latest, back, setBack, endChip, setEndChip, onPosition, goTo, readingStory, markFinished, onScrolledToEnd };
}
