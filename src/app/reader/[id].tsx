import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { type Block, type Position, blockText } from '@/engine/types';
import { addBookmark, highlightsByBlock, removeBookmark, useAnnotations } from '@/lib/annotations';
import { getBook, loadManifest, updateBook, useBookStatus, useLiveBook } from '@/lib/library';
import { THEMES, useSettings } from '@/lib/settings';
import { ReadingTracker, charsPerMinute } from '@/lib/stats';
import { BookData } from '@/reader/book';
import { Chrome } from '@/reader/Chrome';
import type { Mark } from '@/reader/marks';
import { PageReader } from '@/reader/PageReader';
import { ScrollReader } from '@/reader/ScrollReader';
import { SelectionSheet, highlightColor } from '@/reader/SelectionSheet';
import { NavigatorSheet, SearchSheet, SettingsSheet } from '@/reader/Sheets';
import { formatMinutes } from '@/ui/format';

const before = (a: Position, b: Position) => a.b < b.b || (a.b === b.b && a.o <= b.o);

export default function ReaderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  useKeepAwake();
  const settings = useSettings();
  const theme = THEMES[settings.theme];
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
  const [sheet, setSheet] = useState<'nav' | 'search' | 'settings' | null>(null);
  const [selection, setSelection] = useState<{ b: number; block: Block; chapter?: string } | null>(null);
  const [searchMark, setSearchMark] = useState<{ b: number; s: number; e: number } | null>(null);

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
    (b: number) => {
      const block = book?.block(b);
      if (!block || !block.r) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      setChrome(false);
      setSelection({ b, block, chapter: book?.chapterAt(b)?.t });
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

  if (!book || status === 'error') {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <Text style={{ color: theme.text, marginBottom: 16 }}>{book ? getBook(id)?.error ?? 'This book could not be opened.' : 'Book not found.'}</Text>
        <Pressable onPress={() => router.back()}>
          <Text style={{ color: theme.accent, fontSize: 16 }}>Back to library</Text>
        </Pressable>
      </View>
    );
  }

  if (book.chunkCount === 0) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <ActivityIndicator color={theme.muted} />
        <Text style={{ color: theme.muted, marginTop: 12 }}>Preparing book… {Math.round((live?.progress ?? 0) * 100)}%</Text>
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
      <StatusBar hidden={!chrome} style={theme.dark ? 'light' : 'dark'} />
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
        bookmarked={pageBookmarks.length > 0}
        footerRight={footerRight}
      />
      <Chrome
        visible={chrome}
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
        onSettings={() => setSheet('settings')}
        onSeek={async (f) => goTo(await book.positionAt(f))}
      />
      <NavigatorSheet visible={sheet === 'nav'} onClose={() => setSheet(null)} theme={theme} book={book} currentBlock={pos.b} onGo={goTo} />
      <SearchSheet visible={sheet === 'search'} onClose={() => setSheet(null)} theme={theme} book={book} onGo={goTo} />
      <SettingsSheet visible={sheet === 'settings'} onClose={() => setSheet(null)} theme={theme} settings={settings} />
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
