// The reader screen: the book's page (WebReader) and what's drawn over it, the
// menu, sheets, panels and chips. What it keeps track of is in hooks of its
// own: the book (useReaderBook), the place read (useReadingPlace), selected
// text and the highlighter (useReaderSelection), auto reading (useAutoRead)
// and the Display panel's sliders (useDisplayDraft).

import * as Haptics from 'expo-haptics';
import * as ScreenOrientation from 'expo-screen-orientation';
import { type ErrorBoundaryProps, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, type LayoutChangeEvent, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { type Position, blockText } from '@/engine/types';
import { addBookmark, highlightsByBlock, removeBookmark, useAnnotations } from '@/lib/annotations';
import { useRecordScreenError } from '@/lib/crashLog';
import { getBook, reprocessBook } from '@/lib/library';
import { snippetAt } from '@/lib/remap';
import { ensureFont } from '@/lib/fonts';
import { setSettings, useReaderTheme, useSettings } from '@/lib/settings';
import { charsPerMinute } from '@/lib/stats';
import { Chrome } from '@/reader/Chrome';
import type { Mark } from '@/reader/marks';
import { LookupSheet } from '@/reader/LookupSheet';
import { SelectionMenu } from '@/reader/SelectionMenu';
import { type PageInfo, SCROLL_BADGE, WebReader, useReadingArea } from '@/reader/web/WebReader';
import { FOOTER, toolBar } from '@/reader/web/frame';
import { AutoBar } from '@/reader/AutoBar';
import { stepWpm } from '@/reader/autoRead';
import { BackChip } from '@/reader/BackChip';
import { backLayer } from '@/reader/backLayer';
import { GoToSheet } from '@/reader/GoToSheet';
import { DisplayPanel } from '@/reader/DisplayPanel';
import { HighlightBar } from '@/reader/HighlightBar';
import { TapZones } from '@/reader/TapZones';
import { LivePreview } from '@/reader/LivePreview';
import { NoteSheet } from '@/reader/NoteSheet';
import { readerInfo } from '@/reader/readerInfo';
import { useScreenAwake } from '@/reader/screenAwake';
import { NavigatorSheet, SearchSheet } from '@/reader/Sheets';
import { SystemBars } from '@/reader/SystemBars';
import { useAutoRead } from '@/reader/useAutoRead';
import { useDisplayDraft } from '@/reader/useDisplayDraft';
import { useReaderBook } from '@/reader/useReaderBook';
import { useReaderSelection } from '@/reader/useReaderSelection';
import { useReadingPlace } from '@/reader/useReadingPlace';
import { ErrorScreen } from '@/ui/ErrorScreen';
import { highlightColor } from '@/ui/theme';
import { Tap } from '@/ui/Tap';

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
  // The page loads its font itself; the phone's own text (the preview while a
  // slider is dragged, notes) uses it too once it's loaded, in the background.
  useEffect(() => {
    ensureFont(settings.font).catch(() => {});
  }, [settings.font]);
  const { book, status, live, version, savedPos, startPos, lang, needGuess } = useReaderBook(id, atB, atO);
  const ann = useAnnotations(id);

  const [chrome, setChrome] = useState(false);
  const [sheet, setSheet] = useState<'nav' | 'search' | 'display' | 'goto' | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (book) book.onError = (e) => setFailed(e instanceof Error ? e.message : String(e));
  }, [book]);

  // Page numbers (page mode only), reported by the page reader.
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
  const pageInfoRef = useRef(pageInfo);
  pageInfoRef.current = pageInfo;
  /** Auto page turn or auto-scroll is running (its time counts as reading at its pace). */
  const autoRunning = useRef(false);
  const closeOverPage = useCallback(() => {
    setSheet(null);
    setChrome(false);
  }, []);
  const place = useReadingPlace({
    id,
    book,
    version,
    startPos,
    savedPos,
    openedElsewhere: atB !== undefined,
    autoRunning,
    pageInfo: pageInfoRef,
    onJump: closeOverPage,
  });
  const { jump, pos, end, searchMark, latest, back, setBack, endChip, setEndChip, onPosition, goTo, readingStory, markFinished, onScrolledToEnd } = place;

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

  const { draft, onLayoutReady, onSlide } = useDisplayDraft(settings);
  const { selection, sel, setSel, highlighting, setHighlighting, stopHighlighting, selEnds, onSelection, onReaderPosition, onMarkTap, onMarkDrag, strokeMarks } =
    useReaderSelection({ id, book, settings, theme, jumpKey: jump.key, onPosition, setChrome });

  const win = useWindowDimensions();
  const { auto, setAuto, stopAuto, pauseAuto, autoWpm, autoActive, turn, pageTimer, autoScroll } = useAutoRead({
    id,
    book,
    settings,
    pos,
    end,
    covered: chrome || !!sheet || !!note || !!sel || highlighting,
    width: win.width,
  });
  autoRunning.current = !!auto?.running;
  // Turning past the last page: the book is read; say so (instead of nothing happening).
  const pastEnd = useCallback(() => {
    setAuto(null);
    if (readingStory()) markFinished();
  }, [readingStory, markFinished, setAuto]);
  // A tap in the middle of the page pauses auto reading rather than opening the menu.
  const toggleChrome = useCallback(() => {
    if (autoRunning.current) setAuto({ running: false });
    else setChrome((c) => !c);
  }, [setAuto]);
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

  // Highlights and the current search hit, as drawable marks per block.
  const marks = useMemo(() => {
    const m = new Map<number, Mark[]>();
    for (const [b, list] of highlightsByBlock(id)) m.set(b, list.map((h) => ({ s: h.s, e: h.e, color: highlightColor(h.color, theme.dark) })));
    if (searchMark) m.set(searchMark.b, [...(m.get(searchMark.b) ?? []), { s: searchMark.s, e: searchMark.e, color: theme.accent + '55' }]);
    return m;
    // `ann` changes whenever highlights do.
  }, [id, ann, searchMark, theme.dark, theme.accent]); // eslint-disable-line react-hooks/exhaustive-deps
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

  const { prevChapter, nextChapter, footerRight, fraction, sliderPage, pageLabel, chromeInfo, dragChapter, dragInfo, backLabel } = readerInfo(
    book,
    pos,
    pageInfo,
    back,
    charsPerMinute(id),
  );
  /** Go to page `n` by its number, or to a fraction of the book. */
  const goToPlace = async (f: number, n?: number) => goTo(await book.positionAt(f), undefined, true, n);
  // Bars at the bottom stay clear of the page number (or scroll mode's strip).
  const overFooter = area.bottom + (settings.mode === 'page' ? FOOTER : SCROLL_BADGE) + 6;
  const bar = toolBar(area.top, settings.mode);

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
        stroke={strokeMarks}
        onLink={onLink}
        bookmarked={pageBookmarks.length > 0}
        footerRight={footerRight}
        onLayoutReady={onLayoutReady}
        onPageInfo={setPageInfo}
        turn={turn}
        autoScroll={autoScroll}
        onAutoInterrupt={pauseAuto}
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
          height={bar.height}
          row={bar.row}
          reach={bar.reach}
          left={area.left}
          right={area.right}
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
