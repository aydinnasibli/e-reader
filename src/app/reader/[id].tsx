import * as Haptics from 'expo-haptics';
import * as ScreenOrientation from 'expo-screen-orientation';
import { type ErrorBoundaryProps, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, BackHandler, type LayoutChangeEvent, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { normaliseLanguage } from '@/engine/language';
import { type Position, blockText } from '@/engine/types';
import { addBookmark, highlightsByBlock, removeBookmark, useAnnotations } from '@/lib/annotations';
import { useRecordScreenError } from '@/lib/crashLog';
import { getBook, loadManifest, reprocessBook, setBookOpen, updateBook, useBookStatus, useLiveBook } from '@/lib/library';
import { snippetAt } from '@/lib/remap';
import { ensureFont } from '@/lib/fonts';
import { type ReaderSettings, setSettings, useReaderTheme, useSettings } from '@/lib/settings';
import { ReadingTracker, charsPerMinute, readingSpeed } from '@/lib/stats';
import { BookData } from '@/reader/book';
import { Chrome } from '@/reader/Chrome';
import type { Mark } from '@/reader/marks';
import { pageAtFraction } from '@/reader/pageNumbers';
import { LookupSheet } from '@/reader/LookupSheet';
import type { TextPoint } from '@/reader/selection';
import { SelectionMenu } from '@/reader/SelectionMenu';
import { type PageInfo, type PageSelection, SCROLL_BADGE, WebReader, useReadingArea } from '@/reader/web/WebReader';
import { FOOTER } from '@/reader/web/frame';
import { useSelection } from '@/reader/useSelection';
import { AutoBar } from '@/reader/AutoBar';
import { CHARS_PER_WORD, pageDelay, scrollSpeed, stepWpm } from '@/reader/autoRead';
import { BackChip } from '@/reader/BackChip';
import { backLayer } from '@/reader/backLayer';
import { finishesBook, storyEnd } from '@/reader/finish';
import { GoToSheet } from '@/reader/GoToSheet';
import { chapterTarget } from '@/reader/navigate';
import { DisplayPanel } from '@/reader/DisplayPanel';
import { HighlightBar } from '@/reader/HighlightBar';
import { TapZones } from '@/reader/TapZones';
import { LivePreview } from '@/reader/LivePreview';
import { NoteSheet } from '@/reader/NoteSheet';
import { useScreenAwake } from '@/reader/screenAwake';
import { NavigatorSheet, SearchSheet } from '@/reader/Sheets';
import { SystemBars } from '@/reader/SystemBars';
import { ErrorScreen } from '@/ui/ErrorScreen';
import { formatMinutes } from '@/ui/format';
import { highlightColor } from '@/ui/theme';
import { Tap } from '@/ui/Tap';

const before = (a: Position, b: Position) => a.b < b.b || (a.b === b.b && a.o <= b.o);
const strictlyBefore = (a: Position, b: Position) => a.b < b.b || (a.b === b.b && a.o < b.o);

/** The place is saved a moment after it stops changing, and at least this often while it keeps changing (auto-scroll). */
const SAVE_DEBOUNCE_MS = 800;
const SAVE_EVERY_MS = 5000;

export default function ReaderScreen() {
  // `b`/`o`: open at that place instead of where reading left off (from the highlights screen).
  const { id, b: atB, o: atO } = useLocalSearchParams<{ id: string; b?: string; o?: string }>();
  const settings = useSettings();
  const theme = useReaderTheme(settings);
  // Rotation lock while reading; back to free rotation when leaving the book.
  useEffect(() => {
    const { OrientationLock } = ScreenOrientation;
    const lock =
      settings.rotation === 'portrait' ? OrientationLock.PORTRAIT_UP : settings.rotation === 'landscape' ? OrientationLock.LANDSCAPE : OrientationLock.DEFAULT;
    ScreenOrientation.lockAsync(lock).catch(() => {});
    return () => {
      ScreenOrientation.lockAsync(OrientationLock.DEFAULT).catch(() => {});
    };
  }, [settings.rotation]);
  // The page loads its font itself; the phone's own text (the preview while a
  // slider is dragged, notes) uses it too once it's loaded, in the background.
  useEffect(() => {
    ensureFont(settings.font).catch(() => {});
  }, [settings.font]);
  const status = useBookStatus(id);
  const live = useLiveBook(id);
  const ann = useAnnotations(id);

  // The library doesn't swap in a book converted again while it's open here.
  // It's marked open before its manifest is read: a swap in between would
  // leave the reader with the old manifest over the new chunks (and its saves
  // would put an old place over the one moved to the new blocks).
  const opened = useRef<string | null>(null);
  const book = useMemo(() => {
    const entry = getBook(id);
    if (!entry) return null;
    if (opened.current !== id) {
      setBookOpen(id, true);
      opened.current = id;
    }
    const b = new BookData(entry);
    if (entry.status === 'ready') {
      const m = loadManifest(id);
      if (m) b.setManifest(m);
    }
    return b;
  }, [id]);
  useEffect(() => () => book?.close(), [book]);
  useEffect(() => {
    if (book && opened.current !== id) {
      setBookOpen(id, true);
      opened.current = id;
    }
    return () => {
      if (opened.current) setBookOpen(opened.current, false);
      opened.current = null;
    };
  }, [id, book]);

  // Keep the book in sync while it is still converting, and when it finishes.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (book && live) {
      book.setLive(live);
      setVersion((v) => v + 1);
    }
  }, [book, live]);
  // The moment conversion finishes, take the manifest during this render (not
  // in an effect), so the damaged-book check below never sees a finished book
  // without it and the reader isn't torn down and rebuilt.
  if (book && status === 'ready' && !book.complete) {
    const m = loadManifest(id);
    if (m) book.setManifest(m);
  }
  useEffect(() => {
    if (status === 'ready') setVersion((v) => v + 1);
  }, [status]);

  const savedPos = useMemo<Position>(() => getBook(id)?.position ?? { b: 0, o: 0 }, [id]);
  const startPos = useMemo<Position>(() => (atB !== undefined ? { b: Number(atB) || 0, o: Number(atO) || 0 } : savedPos), [savedPos, atB, atO]);

  // The book's language: set by hand in Book details, or the book's own. A
  // book converted before languages were worked out has neither: it's told
  // from the text before anything is drawn (hyphenation and the page's text
  // depend on it, and must not change under the reader).
  const [guessedLang, setGuessedLang] = useState<string | null | undefined>(undefined);
  const ownLang = normaliseLanguage(getBook(id)?.lang ?? book?.manifest?.lang);
  const lang = ownLang ?? guessedLang ?? undefined;
  const needGuess = !!book && !ownLang && guessedLang === undefined;
  const canGuess = !!book && book.chunkCount > 0;
  useEffect(() => {
    if (!needGuess || !canGuess || !book) return;
    let alive = true;
    book.guessLanguage(startPos).then((g) => alive && setGuessedLang(g ?? null));
    return () => {
      alive = false;
    };
  }, [needGuess, canGuess, book, startPos]);

  // Readers open at `latest`; bumping `jump.key` makes them jump there.
  const [jump, setJump] = useState<{ pos: Position; key: number; page?: number }>({ pos: startPos, key: 0 });
  const [pos, setPos] = useState<Position>(startPos);
  const [end, setEnd] = useState<Position | undefined>(undefined);
  const [chrome, setChrome] = useState(false);
  const [sheet, setSheet] = useState<'nav' | 'search' | 'display' | 'goto' | null>(null);
  const [searchMark, setSearchMark] = useState<{ b: number; s: number; e: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (book) book.onError = (e) => setFailed(e instanceof Error ? e.message : String(e));
  }, [book]);

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
  // Scroll mode: the end came into view while reading on from the story.
  /** Reading since the last jump started in the story (not in notes jumped to). */
  const readingStory = useCallback(() => {
    const start = runStart.current?.b;
    const storyEnd = storyEndRef.current;
    return start !== undefined && (storyEnd === null || start < storyEnd);
  }, []);
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
  const jumpedFrom = useRef<{ pos: Position; percent?: number } | null>(atB !== undefined ? { pos: savedPos, percent: getBook(id)?.percent } : null);
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
  /**
   * The chip's way back: the place, page turns since, the page number the
   * footer showed there in its layout (the chip says the same while the
   * layout hasn't changed), and how far into its chunk the place is (for
   * the page it's on, in another layout).
   */
  const [back, setBack] = useState<{ pos: Position; turns: number; shown?: { page: number; key: string }; f?: number } | null>(
    atB !== undefined ? { pos: savedPos, turns: 0 } : null,
  );
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
    [save, book, tracker, reachEnd],
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

  // Page numbers (page mode only), reported by the page reader.
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
  const pageInfoRef = useRef(pageInfo);
  pageInfoRef.current = pageInfo;

  // "Back to where I was": the place before the last jump, until used,
  // dismissed, or read past (about ten page turns on). Opened at a highlight:
  // the way back to where reading left off. `shown` is the page number the
  // footer showed there, in its layout: the chip says the same while the
  // layout hasn't changed.
  /** Jump to `p` (with `page`, to that page by its number: the page mode reader lands on it exactly). */
  const goTo = useCallback(
    (p: Position, mark?: { s: number; e: number }, remember = true, page?: number) => {
      const info = pageInfoRef.current;
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
      setSheet(null);
      setChrome(false);
    },
    [book],
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
  // Auto page turn (page mode) / auto-scroll (scroll mode). A tap in the
  // middle of the page pauses it rather than opening the menu.
  const [auto, setAuto] = useState<{ running: boolean } | null>(null);
  const autoRunning = useRef(false);
  autoRunning.current = !!auto?.running;
  // The end of the book: auto reading is over.
  const stopAuto = useCallback(() => setAuto(null), []);
  // Turning past the last page: the book is read; say so (instead of nothing happening).
  const pastEnd = useCallback(() => {
    setAuto(null);
    if (readingStory()) markFinished();
  }, [readingStory, markFinished]);
  const toggleChrome = useCallback(() => {
    if (autoRunning.current) setAuto({ running: false });
    else setChrome((c) => !c);
  }, []);

  // A link on the page: a note opens over the page; any other place in the
  // book (a note's link back to its reference) is jumped to.
  const onLink = useCallback(
    (target: string) => {
      setChrome(false);
      const m = book?.manifest;
      const anchor = m?.anchors?.[target];
      // To the page with the reference itself, where the converter says where in its paragraph it is.
      if (anchor !== undefined && !m?.notes?.[target]) goTo({ b: anchor, o: m?.anchorOffsets?.[target] ?? 0 });
      else setNote(target);
    },
    [book, goTo],
  );

  // Display sliders: `draft` holds the values being dragged, drawn by
  // LivePreview. On release the values are saved and the preview stays until
  // the reader has laid out pages with them (or a few seconds at most).
  const [draft, setDraft] = useState<Partial<ReaderSettings> | null>(null);
  // Layouts the reader has finished, counted; on release we wait for the next one.
  const readyCount = useRef(0);
  const waitingAfter = useRef<number | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endDraft = useCallback(() => {
    waitingAfter.current = null;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    setDraft(null);
  }, []);
  const onLayoutReady = useCallback(() => {
    readyCount.current++;
    if (waitingAfter.current !== null && readyCount.current > waitingAfter.current) endDraft();
  }, [endDraft]);
  const onSlide = useCallback(
    (patch: Partial<ReaderSettings>, done: boolean) => {
      if (!done) {
        if (draftTimer.current) clearTimeout(draftTimer.current);
        waitingAfter.current = null;
        setDraft((d) => ({ ...d, ...patch }));
        return;
      }
      const changed = (Object.keys(patch) as (keyof ReaderSettings)[]).some((k) => patch[k] !== settings[k]);
      setSettings(patch);
      // Scroll mode redraws at once; page mode needs its new pages first.
      if (!changed || settings.mode !== 'page') return endDraft();
      waitingAfter.current = readyCount.current;
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(endDraft, 4000);
    },
    [settings, endDraft],
  );
  useEffect(() => () => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
  }, []);

  // Selecting text: a long press selects a word, with a menu to copy, look
  // up, translate or share it, and handles at both ends to move it. The
  // highlight tool (bottom menu) is a marker: a tap or a drag highlights, or
  // takes highlighting away when it starts on a highlight. No selection.
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
  useEffect(() => setSel(null), [jump.key, setSel]);
  // The page selects text itself (the browser's own handles); the menu goes over its ends.
  const [selEnds, setSelEnds] = useState<Pick<PageSelection, 'start' | 'end'> | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const onSelection = useCallback((s: PageSelection | null) => {
    if (s) Haptics.selectionAsync().catch(() => {});
    setChrome(false);
    selectionRef.current.setSel(s ? { a: s.a, z: s.z } : null);
    setSelEnds(s ? { start: s.start, end: s.end } : null);
  }, []);
  useEffect(() => {
    if (!sel) setSelEnds(null);
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

  const win = useWindowDimensions();
  const autoWpm = settings.autoWpm || Math.max(60, Math.round(readingSpeed(id).cpm / CHARS_PER_WORD / 10) * 10);
  // Runs only while nothing else is in front of the page.
  const autoActive = !!auto?.running && !chrome && !sheet && !note && !sel && !highlighting;
  // The screen stays on while reading (Display → Page), counted from the last page turn or tap.
  useScreenAwake(settings.screenAwake, `${pos.b}:${pos.o}:${chrome}:${sheet}:${!!sel}:${note !== null}:${highlighting}`, autoActive);
  // First time in page mode: the tap zones are shown.
  const showGuide = settings.mode === 'page' && !settings.seenTapZones && !highlighting && !sheet;
  // Android back closes what's drawn over the page first, then leaves the book.
  const closeTop = useRef<() => boolean>(() => false);
  closeTop.current = () => {
    const layer = backLayer({
      selection: !!sel,
      display: sheet === 'display',
      highlighting,
      menu: chrome,
      auto: !!auto,
      guide: showGuide,
    });
    if (layer === 'selection') setSel(null);
    else if (layer === 'display') {
      setSheet(null);
      setChrome(false);
    } else if (layer === 'highlight') stopHighlighting();
    else if (layer === 'menu') setChrome(false);
    else if (layer === 'auto') setAuto(null);
    else if (layer === 'guide') setSettings({ seenTapZones: true });
    return layer !== null;
  };
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => closeTop.current());
    return () => sub.remove();
  }, []);
  const [turn, setTurn] = useState<{ dir: 1 | -1; n: number } | undefined>(undefined);
  // How long the page on screen stays, shown filling up in the auto bar (a
  // page takes its reading time, up to a minute or more: it must be seen working).
  const [pageTimer, setPageTimer] = useState<{ ms: number; n: number } | null>(null);
  useEffect(() => {
    if (!autoActive || settings.mode !== 'page' || !book) {
      setPageTimer(null);
      return;
    }
    const from = book.charOffset(pos);
    const to = end ? book.charOffset(end) : from + 1500;
    const delay = pageDelay(Math.max(1, to - from), autoWpm);
    setPageTimer((p) => ({ ms: delay, n: (p?.n ?? 0) + 1 }));
    // The last page: stop when it's read.
    if (book.complete && to >= book.totalChars) {
      const t = setTimeout(() => setAuto(null), delay);
      return () => clearTimeout(t);
    }
    // Re-armed by every turn (and retried if a turn had to wait for text).
    const t = setTimeout(() => setTurn((x) => ({ dir: 1, n: (x?.n ?? 0) + 1 })), delay);
    return () => clearTimeout(t);
  }, [autoActive, pos, end, autoWpm, settings.mode, book, turn]);
  const textWidth = win.width - settings.margin * 2;
  const autoScroll = autoActive && settings.mode === 'scroll' ? scrollSpeed(autoWpm, textWidth, settings.fontSize, Math.round(settings.fontSize * settings.lineSpacing)) : 0;

  // Highlights, the current search hit and a highlight being dragged, as drawable marks per block.
  const marks = useMemo(() => {
    const m = new Map<number, Mark[]>();
    const add = (b: number, mark: Mark) => m.set(b, [...(m.get(b) ?? []), mark]);
    for (const [b, list] of highlightsByBlock(id)) m.set(b, list.map((h) => ({ s: h.s, e: h.e, color: highlightColor(h.color, theme.dark) })));
    if (searchMark) add(searchMark.b, { s: searchMark.s, e: searchMark.e, color: theme.accent + '55' });
    // A highlight tool drag as it goes: the new highlight, or the page showing through where it erases.
    const { stroke } = selection;
    if (stroke) for (const r of stroke.ranges) add(r.b, { s: r.s, e: r.e, color: stroke.erase ? theme.bg : highlightColor(settings.highlightColor, theme.dark) });
    return m;
    // `ann` changes whenever highlights do.
  }, [id, ann, searchMark, selection.stroke, theme.dark, theme.accent, theme.bg, settings.highlightColor]); // eslint-disable-line react-hooks/exhaustive-deps
  const marksFor = useCallback((b: number) => marks.get(b), [marks]);

  // Bookmarks on the visible page.
  // `end` is where the next page starts, so it isn't part of this page.
  const pageBookmarks = ann.bookmarks.filter((bm) => before(pos, bm) && (end ? strictlyBefore(bm, end) : bm.b === pos.b));
  const toggleBookmark = () => {
    if (!book) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (pageBookmarks.length) for (const bm of pageBookmarks) removeBookmark(id, bm.id);
    else {
      const blk = book.block(pos.b);
      // The label the library also makes for a bookmark moved to a book converted again.
      const snippet = snippetAt(blk ? blockText(blk) : '', pos.o);
      addBookmark(id, { b: pos.b, o: pos.o, snippet, chapter: book.chapterAt(pos.b)?.t });
    }
  };

  // The menu shows unless the display panel has taken its place; the system bars show with it.
  const menu = chrome && sheet !== 'display';
  // The reader's own size, once laid out (see useReadingArea).
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const onBox = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBox((b) => (b && b.width === width && b.height === height ? b : { width, height }));
  }, []);
  const { area, settled, steady } = useReadingArea(menu, box);

  if (!book) {
    return <ErrorScreen title="Book not found" actions={[{ label: 'Back to library', onPress: () => router.back(), primary: true }]} />;
  }
  // Converted data missing or damaged: offer to convert again from the original file.
  if (status === 'error' || failed || (status === 'ready' && !book.complete)) {
    return (
      <ErrorScreen
        title="This book couldn't be opened"
        message={failed ?? getBook(id)?.error ?? 'Its prepared data is missing or damaged.'}
        actions={[
          {
            label: 'Try again',
            primary: true,
            onPress: () => {
              reprocessBook(id);
              router.back();
            },
          },
          { label: 'Back to library', onPress: () => router.back() },
        ]}
      />
    );
  }

  if (book.chunkCount === 0 || needGuess) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <ActivityIndicator color={theme.muted} />
        {book.chunkCount === 0 ? <Text style={{ color: theme.muted, marginTop: 12 }}>{`Preparing book… ${Math.round((live?.progress ?? 0) * 100)}%`}</Text> : null}
        <Tap onPress={() => router.back()} style={{ marginTop: 24 }}>
          <Text style={{ color: theme.accent, fontSize: 16 }}>Back to library</Text>
        </Tap>
      </View>
    );
  }

  // Time left, from this reader's measured speed.
  const speed = charsPerMinute(id);
  const here = book.charOffset(pos);
  const prevChapter = chapterTarget(book.toc, pos, -1);
  const nextChapter = chapterTarget(book.toc, pos, 1);
  const chapterLeft = nextChapter !== null ? (book.charOffset({ b: nextChapter, o: 0 }) - here) / speed : null;
  const bookLeft = (book.estimatedChars - here) / speed;
  const footerRight = chapterLeft !== null && chapterLeft > 0 ? `${formatMinutes(chapterLeft)} left in chapter` : `${formatMinutes(bookLeft)} left`;
  const fraction = book.fraction(pos);
  const numbers = pageInfo?.numbers;
  /** The page a place is on, in the layout's numbering (exact at a chunk's start, estimated inside it). */
  const pageOfPlace = (p: Position) => numbers!.at(book.chunkOf(p.b), book.fractionInChunk(p));
  /** Pages from page `n` to the start of the chapter after block `b`. */
  const pagesLeftFrom = (n: number, b: number) => {
    const next = chapterTarget(book.toc, { b, o: 0 }, 1);
    return numbers && next !== null ? Math.max(0, pageOfPlace({ b: next, o: 0 }) - n) : null;
  };
  /** The page the slider at `f` stands for: the one shown where reading is, the first and last at its ends (the last converted so far, while converting). */
  const sliderPage = pageInfo ? (f: number) => Math.min(numbers!.ready, pageAtFraction(f, fraction, pageInfo.page, pageInfo.total)) : undefined;
  const pageLabel = sliderPage ? (f: number) => `Page ${sliderPage(f)} of ${pageInfo!.approx ? '~' : ''}${pageInfo!.total}` : undefined;
  const infoAt = (pagesLeft: number | null) =>
    !book.complete
      ? `Preparing book ${Math.round(book.progress * 100)}%`
      : pagesLeft
        ? `${pagesLeft} ${pagesLeft === 1 ? 'page' : 'pages'} left in chapter · ${formatMinutes(bookLeft)} left`
        : `${formatMinutes(bookLeft)} left in book`;
  const chromeInfo = infoAt(pageInfo ? pagesLeftFrom(pageInfo.page, pos.b) : null);
  // While the slider is dragged: the chapter and pages left where it would go.
  const dragChapter = (f: number) => book.chapterAt(book.blockAtFraction(f))?.t;
  const dragInfo = (f: number) => infoAt(sliderPage ? pagesLeftFrom(sliderPage(f), book.blockAtFraction(f)) : null);
  /** Go to page `n` by its number, or to a fraction of the book. */
  const goToPlace = async (f: number, n?: number) => goTo(await book.positionAt(f), undefined, true, n);
  const backLabel = back
    ? pageInfo
      ? `Back to page ${back.shown && back.shown.key === pageInfo.key ? back.shown.page : numbers!.at(book.chunkOf(back.pos.b), back.f ?? book.fractionInChunk(back.pos))}`
      : `Back to ${Math.round(book.fraction(back.pos) * 100)}%`
    : '';
  // Bars at the bottom stay clear of the page number (or scroll mode's strip).
  const overFooter = area.bottom + (settings.mode === 'page' ? FOOTER : SCROLL_BADGE) + 6;

  return (
    <View testID="reader-screen" style={{ flex: 1, backgroundColor: theme.bg }} onLayout={onBox}>
      <SystemBars shown={menu} dark={theme.dark} />
      <WebReader
        book={book}
        lang={lang}
        settings={settings}
        theme={theme}
        area={area}
        settled={settled}
        steady={steady}
        start={latest.current}
        startKey={jump.key}
        startPage={jump.page}
        version={version}
        onPosition={onReaderPosition}
        onTap={toggleChrome}
        marksFor={marksFor}
        onLink={onLink}
        bookmarked={pageBookmarks.length > 0}
        footerRight={footerRight}
        onLayoutReady={onLayoutReady}
        onPageInfo={setPageInfo}
        turn={turn}
        autoScroll={autoScroll}
        onAutoInterrupt={() => setAuto({ running: false })}
        onEnd={pastEnd}
        onAutoEnd={stopAuto}
        onReachEnd={onScrolledToEnd}
        marking={highlighting}
        onMarkTap={onMarkTap}
        onMarkDrag={onMarkDrag}
        onSelection={onSelection}
        selected={!!sel}
      />
      {endChip && !chrome && !highlighting && !sel && !sheet ? (
        <BackChip
          theme={theme}
          icon="checkmark-done"
          label="Finished · Back to library"
          onPress={() => router.back()}
          onDismiss={() => setEndChip(false)}
        />
      ) : back && !chrome && !highlighting && !sel && !sheet && !auto ? (
        <BackChip
          theme={theme}
          label={backLabel}
          onPress={() => {
            const to = back.pos;
            setBack(null);
            goTo(to, undefined, false);
          }}
          onDismiss={() => setBack(null)}
        />
      ) : null}
      {draft ? <LivePreview book={book} lang={lang} area={area} settings={{ ...settings, ...draft }} theme={theme} pos={pos} /> : null}
      <Chrome
        visible={menu}
        theme={theme}
        title={book.entry.title}
        chapter={book.chapterAt(pos.b)?.t}
        chapterAt={dragChapter}
        fraction={fraction}
        info={chromeInfo}
        infoAt={dragInfo}
        pageLabel={pageLabel}
        bookmarked={pageBookmarks.length > 0}
        onBack={() => router.back()}
        onAuto={() => {
          setChrome(false);
          setAuto({ running: true });
        }}
        autoLabel={settings.mode === 'page' ? 'Auto page turn' : 'Auto-scroll'}
        onSearch={() => setSheet('search')}
        onBookmark={toggleBookmark}
        onContents={() => setSheet('nav')}
        onDisplay={() => setSheet('display')}
        onHighlight={() => {
          setChrome(false);
          setHighlighting(true);
        }}
        // With page numbers the slider goes to the page its label says.
        onSeek={(f) => void goToPlace(f, sliderPage?.(f))}
        onGoTo={() => setSheet('goto')}
        onPrevChapter={prevChapter !== null ? () => goTo({ b: prevChapter, o: 0 }) : undefined}
        onNextChapter={nextChapter !== null ? () => goTo({ b: nextChapter, o: 0 }) : undefined}
      />
      {showGuide ? (
        <TapZones theme={theme} tapForward={settings.tapForward} onDismiss={() => setSettings({ seenTapZones: true })} />
      ) : null}
      {auto && !chrome && !highlighting && !sel ? (
        <AutoBar
          theme={theme}
          bottom={overFooter}
          wpm={autoWpm}
          running={auto.running}
          pageTimer={pageTimer}
          onSlower={() => setSettings({ autoWpm: stepWpm(autoWpm, -1) })}
          onFaster={() => setSettings({ autoWpm: stepWpm(autoWpm, 1) })}
          onToggle={() => setAuto({ running: !auto.running })}
          onStop={() => setAuto(null)}
        />
      ) : null}
      {highlighting ? (
        <HighlightBar
          theme={theme}
          bottom={overFooter}
          color={settings.highlightColor}
          made={selection.made.length > 0}
          hasNote={!!selection.made[0]?.note}
          onColor={(highlightColor) => setSettings({ highlightColor })}
          onNote={selection.noteMade}
          onCopy={selection.copyMade}
          onRemove={selection.removeMade}
          onDone={stopHighlighting}
        />
      ) : null}
      {sel && selEnds && !highlighting ? (
        <SelectionMenu
          start={selEnds.start}
          end={selEnds.end}
          canLookUp={selection.oneWord}
          onCopy={selection.copy}
          onLookUp={() => selection.show('define')}
          onTranslate={() => selection.show('translate')}
          onShare={selection.share}
        />
      ) : null}
      <NavigatorSheet visible={sheet === 'nav'} onClose={() => setSheet(null)} theme={theme} book={book} currentBlock={pos.b} onGo={goTo} />
      <SearchSheet visible={sheet === 'search'} onClose={() => setSheet(null)} theme={theme} book={book} onGo={goTo} />
      <GoToSheet
        visible={sheet === 'goto'}
        theme={theme}
        page={pageInfo ? { page: pageInfo.page, total: pageInfo.total, approx: pageInfo.approx, ready: pageInfo.numbers.ready } : null}
        preparing={book.complete ? null : Math.round(book.progress * 100)}
        fraction={fraction}
        onClose={() => setSheet(null)}
        onGo={(f, page) => void goToPlace(f, page)}
      />
      <DisplayPanel
        visible={sheet === 'display'}
        onClose={() => {
          setSheet(null);
          setChrome(false);
        }}
        settings={settings}
        theme={theme}
        onSlide={onSlide}
      />
      <NoteSheet
        book={book}
        lang={lang}
        target={note}
        settings={settings}
        theme={theme}
        onClose={() => setNote(null)}
        onGo={(p) => {
          setNote(null);
          goTo(p);
        }}
      />
      <LookupSheet lookup={selection.lookup} lang={lang} theme={theme} onChange={selection.setLookup} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useRecordScreenError(error);
  return (
    <ErrorScreen
      title="The reader hit a problem"
      message={error.message}
      // A build that keeps crashing here can still be replaced by a newer one.
      offerUpdate
      actions={[
        { label: 'Try again', onPress: retry, primary: true },
        { label: 'Back to library', onPress: () => router.back() },
      ]}
    />
  );
}
