import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import * as ScreenOrientation from 'expo-screen-orientation';
import { type ErrorBoundaryProps, router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { type Block, type Position, blockText } from '@/engine/types';
import { addBookmark, highlightsByBlock, removeBookmark, useAnnotations } from '@/lib/annotations';
import { getBook, loadManifest, reprocessBook, updateBook, useBookStatus, useLiveBook } from '@/lib/library';
import { useFontReady } from '@/lib/fonts';
import { type ReaderSettings, setSettings, useReaderTheme, useSettings } from '@/lib/settings';
import { ReadingTracker, charsPerMinute } from '@/lib/stats';
import { BookData } from '@/reader/book';
import { Chrome } from '@/reader/Chrome';
import type { Mark } from '@/reader/marks';
import { PageReader } from '@/reader/PageReader';
import { ScrollReader } from '@/reader/ScrollReader';
import { SelectionSheet, highlightColor } from '@/reader/SelectionSheet';
import { DisplayPanel } from '@/reader/DisplayPanel';
import { LivePreview } from '@/reader/LivePreview';
import { NoteSheet } from '@/reader/NoteSheet';
import { NavigatorSheet, SearchSheet } from '@/reader/Sheets';
import { ErrorScreen } from '@/ui/ErrorScreen';
import { formatMinutes } from '@/ui/format';

const before = (a: Position, b: Position) => a.b < b.b || (a.b === b.b && a.o <= b.o);

export default function ReaderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  useKeepAwake();
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
  useEffect(() => {
    if (book && status === 'ready' && !book.complete) {
      const m = loadManifest(id);
      if (m) {
        book.setManifest(m);
        setVersion((v) => v + 1);
      }
    }
  }, [book, status, id]);

  const startPos = useMemo<Position>(() => getBook(id)?.position ?? { b: 0, o: 0 }, [id]);
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

  // Reading time: page turns feed the tracker; jumps reset it.
  const tracker = useRef(new ReadingTracker(id)).current;
  const jumped = useRef(true);

  // Save the position a moment after it stops changing, and when leaving.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(startPos);
  const save = useCallback(() => {
    if (!book) return;
    updateBook(id, { position: latest.current, percent: book.fraction(latest.current), openedAt: Date.now() });
  }, [book, id]);
  const onPosition = useCallback(
    (p: Position, e?: Position) => {
      latest.current = p;
      setPos(p);
      setEnd(e);
      if (book) {
        const ch = book.charOffset(p);
        if (jumped.current) tracker.reset(ch);
        else tracker.turn(ch);
        jumped.current = false;
      }
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(save, 800);
    },
    [save, book, tracker],
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') {
        tracker.flush();
        save();
      }
    });
    return () => {
      sub.remove();
      if (saveTimer.current) clearTimeout(saveTimer.current);
      tracker.flush();
      save();
    };
  }, [save, tracker]);

  const goTo = useCallback((p: Position, mark?: { s: number; e: number }) => {
    latest.current = p;
    jumped.current = true;
    setSearchMark(mark ? { b: p.b, ...mark } : null);
    setJump((j) => ({ pos: p, key: j.key + 1 }));
    setSheet(null);
    setChrome(false);
  }, []);
  const toggleChrome = useCallback(() => setChrome((c) => !c), []);

  // Display sliders: `draft` holds the values being dragged, drawn by
  // LivePreview. On release the values are saved and the preview stays until
  // the reader has laid out pages with them (or a few seconds at most).
  const [draft, setDraft] = useState<Partial<ReaderSettings> | null>(null);
  const readyKey = useRef('');
  const waitingFrom = useRef<string | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endDraft = useCallback(() => {
    waitingFrom.current = null;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    setDraft(null);
  }, []);
  const onLayoutReady = useCallback(
    (key: string) => {
      readyKey.current = key;
      if (waitingFrom.current !== null && key !== waitingFrom.current) endDraft();
    },
    [endDraft],
  );
  const onSlide = useCallback(
    (patch: Partial<ReaderSettings>, done: boolean) => {
      if (!done) {
        if (draftTimer.current) clearTimeout(draftTimer.current);
        waitingFrom.current = null;
        setDraft((d) => ({ ...d, ...patch }));
        return;
      }
      const changed = (Object.keys(patch) as (keyof ReaderSettings)[]).some((k) => patch[k] !== settings[k]);
      setSettings(patch);
      // Scroll mode redraws at once; page mode needs its new pages first.
      if (!changed || settings.mode !== 'page') return endDraft();
      waitingFrom.current = readyKey.current;
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(endDraft, 4000);
    },
    [settings, endDraft],
  );
  useEffect(() => () => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
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

  // Bookmarks on the visible page.
  const pageBookmarks = ann.bookmarks.filter((bm) => before(pos, bm) && (end ? before(bm, end) : bm.b === pos.b));
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
  const nextChapter = book.toc.find((t) => t.b > pos.b);
  const chapterLeft = nextChapter ? (book.charOffset({ b: nextChapter.b, o: 0 }) - here) / speed : null;
  const bookLeft = (book.estimatedChars - here) / speed;
  const footerRight = chapterLeft !== null && chapterLeft > 0 ? `${formatMinutes(chapterLeft)} left in chapter` : `${formatMinutes(bookLeft)} left`;

  const Reader = settings.mode === 'page' ? PageReader : ScrollReader;
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
      />
      {draft ? <LivePreview book={book} settings={{ ...settings, ...draft }} theme={theme} pos={pos} /> : null}
      <Chrome
        visible={chrome && sheet !== 'display'}
        theme={theme}
        title={book.entry.title}
        chapter={book.chapterAt(pos.b)?.t}
        fraction={book.fraction(pos)}
        info={book.complete ? `${formatMinutes(bookLeft)} left in book` : `Preparing book ${Math.round(book.progress * 100)}%`}
        bookmarked={pageBookmarks.length > 0}
        onBack={() => router.back()}
        onSearch={() => setSheet('search')}
        onBookmark={toggleBookmark}
        onContents={() => setSheet('nav')}
        onDisplay={() => setSheet('display')}
        onSeek={async (f) => goTo(await book.positionAt(f))}
      />
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
