import * as Haptics from 'expo-haptics';
import * as ScreenOrientation from 'expo-screen-orientation';
import { type ErrorBoundaryProps, router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { type Block, type Position, blockText } from '@/engine/types';
import { addBookmark, addHighlight, highlightsByBlock, removeBookmark, useAnnotations } from '@/lib/annotations';
import { getBook, loadManifest, reprocessBook, updateBook, useBookStatus, useLiveBook } from '@/lib/library';
import { useFontReady } from '@/lib/fonts';
import { type ReaderSettings, setSettings, useReaderTheme, useSettings } from '@/lib/settings';
import { ReadingTracker, charsPerMinute, readingSpeed } from '@/lib/stats';
import { BookData } from '@/reader/book';
import { Chrome } from '@/reader/Chrome';
import type { Mark } from '@/reader/marks';
import { type PageInfo, PageReader } from '@/reader/PageReader';
import { pagesBetween } from '@/reader/pageNumbers';
import { ScrollReader } from '@/reader/ScrollReader';
import { SelectionSheet, highlightColor } from '@/reader/SelectionSheet';
import { type TextPoint, dragRanges } from '@/reader/selection';
import { AutoBar } from '@/reader/AutoBar';
import { CHARS_PER_WORD, pageDelay, scrollSpeed, stepWpm } from '@/reader/autoRead';
import { BackChip } from '@/reader/BackChip';
import { backLayer } from '@/reader/backLayer';
import { finishesBook, storyEnd } from '@/reader/finish';
import { chapterTarget, parseGoTo } from '@/reader/navigate';
import { DisplayPanel } from '@/reader/DisplayPanel';
import { HighlightBar } from '@/reader/HighlightBar';
import { TapZones } from '@/reader/TapZones';
import { LivePreview } from '@/reader/LivePreview';
import { NoteSheet } from '@/reader/NoteSheet';
import { useScreenAwake } from '@/reader/screenAwake';
import { NavigatorSheet, SearchSheet } from '@/reader/Sheets';
import { showPrompt } from '@/ui/dialogs';
import { ErrorScreen } from '@/ui/ErrorScreen';
import { formatMinutes } from '@/ui/format';

const before = (a: Position, b: Position) => a.b < b.b || (a.b === b.b && a.o <= b.o);
const strictlyBefore = (a: Position, b: Position) => a.b < b.b || (a.b === b.b && a.o < b.o);

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
  // Pages are measured with the real font, so wait until it's loaded.
  const fontReady = useFontReady(settings.font);
  const status = useBookStatus(id);
  const live = useLiveBook(id);
  const ann = useAnnotations(id);

  const book = useMemo(() => {
    const entry = getBook(id);
    if (!entry) return null;
    const b = new BookData(entry);
    if (entry.status === 'ready') {
      const m = loadManifest(id);
      if (m) b.setManifest(m);
    }
    return b;
  }, [id]);
  useEffect(() => () => book?.close(), [book]);

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
  // Readers open at `latest`; bumping `jump.key` makes them jump there.
  const [jump, setJump] = useState({ pos: startPos, key: 0 });
  const [pos, setPos] = useState<Position>(startPos);
  const [end, setEnd] = useState<Position | undefined>(undefined);
  const [chrome, setChrome] = useState(false);
  const [sheet, setSheet] = useState<'nav' | 'search' | 'display' | null>(null);
  const [selection, setSelection] = useState<{ b: number; block: Block; chapter?: string; at?: number } | null>(null);
  const [searchMark, setSearchMark] = useState<{ b: number; s: number; e: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const onLink = useCallback((target: string) => {
    setChrome(false);
    setNote(target);
  }, []);
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
  /** Where reading started since the last jump, and whether the last position shown was the book's last page. */
  const runStart = useRef<Position | null>(null);
  const wasLast = useRef(false);
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
  const onScrolledToEnd = useCallback(() => {
    const start = runStart.current?.b;
    const storyEnd = storyEndRef.current;
    if (start !== undefined && (storyEnd === null || start < storyEnd)) reachEnd();
  }, [reachEnd]);

  // Reading time: page turns feed the tracker; jumps reset it.
  const tracker = useRef(new ReadingTracker(id)).current;
  const jumped = useRef(true);

  // Save the position a moment after it stops changing, and when leaving.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(startPos);
  const save = useCallback(() => {
    if (!book) return;
    // Still converting up to the saved place: its percent can't be worked out yet.
    if (!book.complete && latest.current.b >= book.totalBlocks) return updateBook(id, { openedAt: Date.now() });
    updateBook(id, { position: latest.current, percent: book.fraction(latest.current), openedAt: Date.now() });
  }, [book, id]);
  const onPosition = useCallback(
    (p: Position, e?: Position, last?: boolean) => {
      const prev = latest.current;
      latest.current = p;
      setPos(p);
      setEnd(e);
      if (book) {
        const step = {
          runStart: jumped.current ? null : (runStart.current?.b ?? null),
          prev: prev.b,
          now: p.b,
          last: !!last,
          wasLast: wasLast.current,
          storyEnd: storyEndRef.current,
        };
        if (finishesBook(step)) reachEnd();
        if (jumped.current) runStart.current = p;
        wasLast.current = !!last;
        const ch = book.charOffset(p);
        if (jumped.current) tracker.reset(ch);
        else {
          if (autoRunning.current) tracker.autoTurn(ch);
          else tracker.turn(ch);
          setBack((bk) => (!bk ? bk : bk.turns >= 10 ? null : { ...bk, turns: bk.turns + 1 }));
        }
        jumped.current = false;
      }
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(save, 800);
    },
    [save, book, tracker, reachEnd],
  );
  useEffect(() => {
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
  useEffect(() => setPageInfo(null), [settings.mode]);

  // "Back to where I was": the place before the last jump, until used,
  // dismissed, or read past (about ten page turns on).
  // Opened at a highlight: offer the way back to where reading left off.
  // `shown` is the page number the footer showed there, so the chip says the
  // same, as long as the pages are the same size (no font change since).
  const [back, setBack] = useState<{ pos: Position; turns: number; shown?: PageInfo } | null>(atB !== undefined ? { pos: savedPos, turns: 0 } : null);
  const goTo = useCallback((p: Position, mark?: { s: number; e: number }, remember = true) => {
    if (remember) setBack({ pos: latest.current, turns: 0, shown: pageInfoRef.current ?? undefined });
    latest.current = p;
    jumped.current = true;
    setSearchMark(mark ? { b: p.b, ...mark } : null);
    setJump((j) => ({ pos: p, key: j.key + 1 }));
    setSheet(null);
    setChrome(false);
  }, []);
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
    markFinished();
  }, [markFinished]);
  const toggleChrome = useCallback(() => {
    if (autoRunning.current) setAuto({ running: false });
    else setChrome((c) => !c);
  }, []);

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


  // Highlight tool (bottom menu): while on, dragging over text highlights it.
  const [highlighting, setHighlighting] = useState(false);
  const [stroke, setStroke] = useState<{ from: TextPoint; to: TextPoint } | null>(null);
  const textOf = useCallback(
    (b: number) => {
      const blk = book?.block(b);
      return blk?.r ? blockText(blk) : null;
    },
    [book],
  );
  const saveHighlights = (ranges: { b: number; s: number; e: number }[]) => {
    if (!ranges.length) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    for (const r of ranges) {
      const text = textOf(r.b) ?? '';
      addHighlight(id, { ...r, color: settings.highlightColor, text: text.slice(r.s, r.e), chapter: book?.chapterAt(r.b)?.t });
    }
  };
  const onHighlightDrag = useCallback(
    (from: TextPoint | null, to: TextPoint | null, done: boolean) => {
      if (!from || !to) return setStroke(null);
      if (!done) return setStroke({ from, to });
      setStroke(null);
      saveHighlights(dragRanges(from, to, textOf));
    },
    [textOf, settings.highlightColor, id, book], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const win = useWindowDimensions();
  const autoWpm = settings.autoWpm || Math.max(60, Math.round(readingSpeed(id).cpm / CHARS_PER_WORD / 10) * 10);
  // Runs only while nothing else is in front of the page.
  const autoActive = !!auto?.running && !chrome && !sheet && !note && !selection && !highlighting;
  // The screen stays on while reading (Display → Page), counted from the last page turn or tap.
  useScreenAwake(settings.screenAwake, `${pos.b}:${pos.o}:${chrome}:${sheet}:${!!selection}:${note !== null}:${highlighting}`, autoActive);
  // First time in page mode: the tap zones are shown.
  const showGuide = settings.mode === 'page' && !settings.seenTapZones && !highlighting && !sheet;
  // Android back closes what's drawn over the page first, then leaves the book.
  const closeTop = useRef<() => boolean>(() => false);
  closeTop.current = () => {
    const layer = backLayer({
      display: sheet === 'display',
      highlighting,
      menu: chrome,
      auto: !!auto,
      guide: showGuide,
    });
    if (layer === 'display') {
      setSheet(null);
      setChrome(false);
    } else if (layer === 'highlight') setHighlighting(false);
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
  useEffect(() => {
    if (!autoActive || settings.mode !== 'page' || !book) return;
    const from = book.charOffset(pos);
    const to = end ? book.charOffset(end) : from + 1500;
    const delay = pageDelay(Math.max(1, to - from), autoWpm);
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
    if (stroke) for (const r of dragRanges(stroke.from, stroke.to, textOf)) add(r.b, { s: r.s, e: r.e, color: highlightColor(settings.highlightColor, theme.dark) });
    return m;
    // `ann` changes whenever highlights do.
  }, [id, ann, searchMark, stroke, settings.highlightColor, theme.dark, theme.accent]); // eslint-disable-line react-hooks/exhaustive-deps
  const marksFor = useCallback((b: number) => marks.get(b), [marks]);

  const onLongPressBlock = useCallback(
    (b: number, at?: number) => {
      const block = book?.block(b);
      if (!block || !block.r) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      setChrome(false);
      setSelection({ b, block, chapter: book?.chapterAt(b)?.t, at });
    },
    [book],
  );

  // A tap while highlighting: on a highlight it opens it (colour, note,
  // remove); on plain text it highlights that word.
  const onHighlightTap = (p: TextPoint) => {
    if (ann.highlights.some((h) => h.b === p.b && h.s <= p.o && p.o < h.e)) return onLongPressBlock(p.b, p.o);
    saveHighlights(dragRanges(p, p, textOf));
  };

  // Bookmarks on the visible page.
  // `end` is where the next page starts, so it isn't part of this page.
  const pageBookmarks = ann.bookmarks.filter((bm) => before(pos, bm) && (end ? strictlyBefore(bm, end) : bm.b === pos.b));
  const toggleBookmark = () => {
    if (!book) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (pageBookmarks.length) for (const bm of pageBookmarks) removeBookmark(id, bm.id);
    else {
      const blk = book.block(pos.b);
      const snippet = blk ? blockText(blk).slice(pos.o, pos.o + 140).replace(/\s+/g, ' ').trim() : '';
      addBookmark(id, { b: pos.b, o: pos.o, snippet, chapter: book.chapterAt(pos.b)?.t });
    }
  };

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
            label: 'Prepare it again',
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

  if (book.chunkCount === 0 || !fontReady) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <ActivityIndicator color={theme.muted} />
        <Text style={{ color: theme.muted, marginTop: 12 }}>
          {book.chunkCount === 0 ? `Preparing book… ${Math.round((live?.progress ?? 0) * 100)}%` : 'Loading font…'}
        </Text>
        <Pressable onPress={() => router.back()} style={{ marginTop: 24 }}>
          <Text style={{ color: theme.accent, fontSize: 16 }}>Back to library</Text>
        </Pressable>
      </View>
    );
  }

  // Time left, from this reader's measured speed.
  const speed = charsPerMinute(id);
  const here = book.charOffset(pos);
  const prevChapter = chapterTarget(book.toc, pos.b, -1);
  const nextChapter = chapterTarget(book.toc, pos.b, 1);
  const chapterLeft = nextChapter !== null ? (book.charOffset({ b: nextChapter, o: 0 }) - here) / speed : null;
  const bookLeft = (book.estimatedChars - here) / speed;
  const footerRight = chapterLeft !== null && chapterLeft > 0 ? `${formatMinutes(chapterLeft)} left in chapter` : `${formatMinutes(bookLeft)} left`;
  const pagesLeftInChapter = pageInfo && nextChapter !== null ? pagesBetween(here, book.charOffset({ b: nextChapter, o: 0 }), pageInfo.cpp) : null;
  const pageLabel = pageInfo
    ? (f: number) => `Page ${Math.min(pageInfo.total, Math.max(1, Math.round(f * pageInfo.total)))} of ${pageInfo.total}`
    : undefined;
  const chromeInfo = !book.complete
    ? `Preparing book ${Math.round(book.progress * 100)}%`
    : pagesLeftInChapter
      ? `${pagesLeftInChapter} ${pagesLeftInChapter === 1 ? 'page' : 'pages'} left in chapter · ${formatMinutes(bookLeft)} left`
      : `${formatMinutes(bookLeft)} left in book`;

  const Reader = settings.mode === 'page' ? PageReader : ScrollReader;
  const goToPrompt = () => {
    const pages = pageInfo?.total ?? null;
    showPrompt(pages ? 'Go to page' : 'Go to', {
      placeholder: pages ? `Page 1–${pages}, or a percentage like 45%` : 'A percentage, like 45%',
      confirm: 'Go',
      numbers: true,
      onSubmit: async (text) => {
        const f = parseGoTo(text, pages);
        if (f === null) return Alert.alert(pages ? `Enter a page from 1 to ${pages}, or a percentage.` : 'Enter a percentage from 0 to 100.');
        goTo(await book.positionAt(f));
      },
    });
  };
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <StatusBar hidden={!chrome && sheet !== 'display'} style={theme.dark ? 'light' : 'dark'} />
      <Reader
        key={settings.mode}
        book={book}
        settings={settings}
        theme={theme}
        start={latest.current}
        startKey={jump.key}
        version={version}
        onPosition={onPosition}
        onTap={toggleChrome}
        marksFor={marksFor}
        onLongPressBlock={onLongPressBlock}
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
        highlighting={highlighting}
        onHighlightDrag={onHighlightDrag}
        onHighlightTap={onHighlightTap}
      />
      {endChip && !chrome && !highlighting && !sheet ? (
        <BackChip
          theme={theme}
          icon="checkmark-done"
          label="Finished · Back to library"
          onPress={() => router.back()}
          onDismiss={() => setEndChip(false)}
        />
      ) : back && !chrome && !highlighting && !sheet && !auto ? (
        <BackChip
          theme={theme}
          label={
            pageInfo
              ? `Back to page ${
                  back.shown && Math.abs(back.shown.cpp - pageInfo.cpp) < pageInfo.cpp * 0.02
                    ? back.shown.page
                    : Math.min(pageInfo.total, Math.floor(book.charOffset(back.pos) / pageInfo.cpp) + 1)
                }`
              : `Back to ${Math.round(book.fraction(back.pos) * 100)}%`
          }
          onPress={() => {
            const to = back.pos;
            setBack(null);
            goTo(to, undefined, false);
          }}
          onDismiss={() => setBack(null)}
        />
      ) : null}
      {draft ? <LivePreview book={book} settings={{ ...settings, ...draft }} theme={theme} pos={pos} /> : null}
      <Chrome
        visible={chrome && sheet !== 'display'}
        theme={theme}
        title={book.entry.title}
        chapter={book.chapterAt(pos.b)?.t}
        fraction={book.fraction(pos)}
        info={chromeInfo}
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
        onSeek={async (f) => goTo(await book.positionAt(f))}
        onGoTo={goToPrompt}
        onPrevChapter={prevChapter !== null ? () => goTo({ b: prevChapter, o: 0 }) : undefined}
        onNextChapter={nextChapter !== null ? () => goTo({ b: nextChapter, o: 0 }) : undefined}
      />
      {showGuide ? (
        <TapZones theme={theme} tapForward={settings.tapForward} onDismiss={() => setSettings({ seenTapZones: true })} />
      ) : null}
      {auto && !chrome && !highlighting ? (
        <AutoBar
          theme={theme}
          wpm={autoWpm}
          running={auto.running}
          onSlower={() => setSettings({ autoWpm: stepWpm(autoWpm, -1) })}
          onFaster={() => setSettings({ autoWpm: stepWpm(autoWpm, 1) })}
          onToggle={() => setAuto({ running: !auto.running })}
          onStop={() => setAuto(null)}
        />
      ) : null}
      {highlighting ? (
        <HighlightBar
          theme={theme}
          color={settings.highlightColor}
          onColor={(highlightColor) => setSettings({ highlightColor })}
          onDone={() => setHighlighting(false)}
        />
      ) : null}
      <NavigatorSheet visible={sheet === 'nav'} onClose={() => setSheet(null)} theme={theme} book={book} currentBlock={pos.b} onGo={goTo} />
      <SearchSheet visible={sheet === 'search'} onClose={() => setSheet(null)} theme={theme} book={book} onGo={goTo} />
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
        target={note}
        settings={settings}
        theme={theme}
        onClose={() => setNote(null)}
        onGo={(p) => {
          setNote(null);
          goTo(p);
        }}
      />
      <SelectionSheet
        bookId={id}
        bookTitle={book.entry.title}
        lang={book.manifest?.lang}
        target={selection}
        theme={theme}
        onClose={() => setSelection(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <ErrorScreen
      title="The reader hit a problem"
      message={error.message}
      actions={[
        { label: 'Try again', onPress: retry, primary: true },
        { label: 'Back to library', onPress: () => router.back() },
      ]}
    />
  );
}
