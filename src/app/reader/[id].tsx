import { useKeepAwake } from 'expo-keep-awake';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Position } from '@/engine/types';
import { getBook, loadManifest, updateBook, useBookStatus, useLiveBook } from '@/lib/library';
import { THEMES, useSettings } from '@/lib/settings';
import { BookData } from '@/reader/book';
import { Chrome } from '@/reader/Chrome';
import { PageReader } from '@/reader/PageReader';
import { ScrollReader } from '@/reader/ScrollReader';
import { SettingsSheet, TocSheet } from '@/reader/Sheets';

export default function ReaderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  useKeepAwake();
  const settings = useSettings();
  const theme = THEMES[settings.theme];
  const status = useBookStatus(id);
  const live = useLiveBook(id);

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
  const [chrome, setChrome] = useState(false);
  const [sheet, setSheet] = useState<'toc' | 'settings' | null>(null);

  // Save the position a moment after it stops changing, and when leaving.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(startPos);
  const save = useCallback(() => {
    if (!book) return;
    updateBook(id, { position: latest.current, percent: book.fraction(latest.current), openedAt: Date.now() });
  }, [book, id]);
  const onPosition = useCallback(
    (p: Position) => {
      latest.current = p;
      setPos(p);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(save, 800);
    },
    [save],
  );
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      save();
    },
    [save],
  );

  const goTo = useCallback((p: Position) => {
    latest.current = p;
    setJump((j) => ({ pos: p, key: j.key + 1 }));
    setSheet(null);
    setChrome(false);
  }, []);
  const toggleChrome = useCallback(() => setChrome((c) => !c), []);

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
      />
      {chrome && (
        <Chrome
          theme={theme}
          title={book.entry.title}
          chapter={book.chapterAt(pos.b)?.t}
          fraction={book.fraction(pos)}
          preparing={book.complete ? undefined : book.progress}
          onBack={() => router.back()}
          onContents={() => setSheet('toc')}
          onSettings={() => setSheet('settings')}
          onSeek={async (f) => goTo(await book.positionAt(f))}
        />
      )}
      <TocSheet
        visible={sheet === 'toc'}
        onClose={() => setSheet(null)}
        theme={theme}
        toc={book.toc}
        currentBlock={pos.b}
        preparing={!book.complete}
        onPick={(t) => goTo({ b: t.b, o: 0 })}
      />
      <SettingsSheet visible={sheet === 'settings'} onClose={() => setSheet(null)} theme={theme} settings={settings} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
