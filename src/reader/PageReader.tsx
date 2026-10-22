// Page mode. Only the current chunk and its neighbours are ever laid out, so
// turning pages costs the same on page 3 of a pamphlet and page 30,000 of a
// 100 MB book.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, PanResponder, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Block, Position } from '@/engine/types';
import type { ReaderSettings, Theme } from '@/lib/settings';
import type { BookData } from './book';
import { BlockImage, BlockText, Spacer } from './BlockText';
import { Measurer } from './Measurer';
import { type Look } from './look';
import { type Measure, type Page, pageOf, paginate } from './paginate';

export const HEADER = 30;
export const FOOTER = 30;

interface Props {
  book: BookData;
  settings: ReaderSettings;
  theme: Theme;
  /** Where to open. Changing `startKey` jumps there. */
  start: Position;
  startKey: number;
  /** Bumped whenever the book grows (still converting) or finishes. */
  version: number;
  onPosition(pos: Position): void;
  onTap(): void;
}

interface Laid {
  blocks: Block[];
  looks: Look[];
  measures: Measure[];
  pages: Page[];
  first: number;
}

interface Cur {
  chunk: number;
  /** null while the chunk is being laid out. */
  page: number | null;
}

export function PageReader({ book, settings, theme, start, startKey, version, onPosition, onTap }: Props) {
  const win = useWindowDimensions();
  const liveInsets = useSafeAreaInsets();
  // Showing/hiding the status bar can change the insets on some iPhones; that
  // must not re-paginate the book, so they are only re-read when the window changes.
  const insets = useMemo(() => liveInsets, [win.width, win.height]); // eslint-disable-line react-hooks/exhaustive-deps
  const width = win.width - settings.margin * 2;
  const pageHeight = Math.floor(win.height - insets.top - insets.bottom - HEADER - FOOTER);
  const layoutKey = `${width}|${pageHeight}|${settings.fontSize}|${settings.lineSpacing}|${settings.font}|${settings.justify}|${settings.indent}`;

  // Laid-out chunks for the current layout.
  const laid = useMemo(() => new Map<number, Laid>(), [layoutKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [, setTick] = useState(0);
  const [cur, setCur] = useState<Cur>(() => ({ chunk: book.chunkOf(start.b), page: null }));
  const target = useRef<{ pos: Position; last?: boolean }>({ pos: start });
  const lastPos = useRef<Position>(start);
  const [measuring, setMeasuring] = useState<{ chunk: number; blocks: Block[]; key: string } | null>(null);

  // Jump requests (TOC, slider) and layout changes both re-target the reader.
  useEffect(() => {
    target.current = { pos: start };
    setCur({ chunk: book.chunkOf(start.b), page: null });
  }, [startKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    target.current = { pos: lastPos.current };
    setCur({ chunk: book.chunkOf(lastPos.current.b), page: null });
    setMeasuring(null);
  }, [layoutKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Decide what to lay out next: current chunk first, then its neighbours.
  useEffect(() => {
    if (measuring) return;
    const want = [cur.chunk, cur.chunk + 1, cur.chunk - 1].filter((c) => c >= 0 && c < book.chunkCount && !laid.has(c));
    if (!want.length) return;
    const chunk = want[0];
    let alive = true;
    book.loadChunk(chunk).then((blocks) => {
      if (alive) setMeasuring({ chunk, blocks, key: layoutKey });
    });
    return () => {
      alive = false;
    };
  }, [cur, measuring, laid, layoutKey, version, book]);

  const onMeasured = useCallback(
    (chunk: number, blocks: Block[], key: string, measures: Measure[], looks: Look[]) => {
      if (key !== layoutKey) return;
      const first = book.chunkStart(chunk);
      laid.set(chunk, { blocks, looks, measures, pages: paginate(blocks, first, measures, looks, pageHeight), first });
      setMeasuring(null);
      setTick((t) => t + 1);
    },
    [book, laid, layoutKey, pageHeight],
  );

  // Resolve a pending target once its chunk is laid out.
  const curLaid = laid.get(cur.chunk);
  useEffect(() => {
    if (cur.page !== null || !curLaid) return;
    const t = target.current;
    let page: number;
    if (t.last) page = curLaid.pages.length - 1;
    else {
      const blk = curLaid.blocks[t.pos.b - curLaid.first];
      const prefix = blk ? curLaid.looks[t.pos.b - curLaid.first].prefix.length : 0;
      page = pageOf(curLaid.pages, t.pos.b, t.pos.o + (t.pos.o > 0 ? prefix : 0));
    }
    setCur({ chunk: cur.chunk, page });
  }, [cur, curLaid]);

  // Report the reading position.
  useEffect(() => {
    if (cur.page === null || !curLaid) return;
    const item = curLaid.pages[cur.page]?.items[0];
    if (!item) return;
    const prefix = curLaid.looks[item.b - curLaid.first]?.prefix.length ?? 0;
    const pos = { b: item.b, o: Math.max(0, item.s - prefix) };
    lastPos.current = pos;
    onPosition(pos);
  }, [cur, curLaid, onPosition]);

  /** The page one step away, or why there isn't one. */
  const neighbour = (dir: 1 | -1): { cur: Cur; pageData?: { laid: Laid; page: Page } } | 'end' | 'processing' | null => {
    if (cur.page === null || !curLaid) return null;
    const p = cur.page + dir;
    if (p >= 0 && p < curLaid.pages.length) return { cur: { chunk: cur.chunk, page: p }, pageData: { laid: curLaid, page: curLaid.pages[p] } };
    const c = cur.chunk + dir;
    if (c < 0) return 'end';
    if (c >= book.chunkCount) return book.complete ? 'end' : 'processing';
    const l = laid.get(c);
    if (!l) return { cur: { chunk: c, page: null } };
    const np = dir > 0 ? 0 : l.pages.length - 1;
    return { cur: { chunk: c, page: np }, pageData: { laid: l, page: l.pages[np] } };
  };

  // ---- gestures and the slide animation ----
  //
  // Pages sit on an endless strip: the current page is at `slot`, its
  // neighbours at slot ± 1, and each page view is keyed by which page it
  // shows. Turning a page only moves the strip; the page that slides in is
  // the same view that becomes current, so nothing is swapped or re-laid out
  // mid-animation (which is what caused visible jumps).

  const [slot, setSlot] = useState(0);
  const base = useRef(new Animated.Value(0)).current; // -slot * width
  const drag = useRef(new Animated.Value(0)).current; // finger offset
  const shift = useMemo(() => Animated.add(base, drag), [base, drag]);
  const animating = useRef(false);
  const springBack = () => Animated.spring(drag, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
  const go = (dir: 1 | -1) => {
    if (animating.current) return;
    const n = neighbour(dir);
    if (!n || n === 'end' || n === 'processing') {
      springBack();
      return;
    }
    animating.current = true;
    const nextSlot = slot + dir;
    Animated.parallel([
      Animated.timing(base, { toValue: -nextSlot * win.width, duration: 220, useNativeDriver: true }),
      Animated.timing(drag, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start(() => {
      if (n.cur.page === null) target.current = { pos: { b: book.chunkStart(n.cur.chunk), o: 0 }, last: dir < 0 };
      setSlot(nextSlot);
      setCur(n.cur);
      animating.current = false;
    });
  };
  // Keep the strip aligned if the window size changes.
  useEffect(() => {
    base.setValue(-slot * win.width);
  }, [win.width]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlers = useRef<{ go(d: 1 | -1): void; onTap(): void; springBack(): void; width: number; canGo(d: 1 | -1): boolean }>({
    go,
    onTap,
    springBack,
    width: win.width,
    canGo: () => true,
  });
  handlers.current = {
    go,
    onTap,
    springBack,
    width: win.width,
    canGo: (d) => {
      const n = neighbour(d);
      return !!n && n !== 'end' && n !== 'processing';
    },
  };
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_e, g) => {
        const dir = g.dx < 0 ? 1 : -1;
        drag.setValue(handlers.current.canGo(dir) ? g.dx : g.dx * 0.25);
      },
      onPanResponderRelease: (e, g) => {
        const w = handlers.current.width;
        if (Math.abs(g.dx) < 8 && Math.abs(g.dy) < 8) {
          const tx = e.nativeEvent.pageX;
          if (tx < w * 0.3) handlers.current.go(-1);
          else if (tx > w * 0.7) handlers.current.go(1);
          else handlers.current.onTap();
          return;
        }
        if (g.dx < -w * 0.15 || g.vx < -0.4) handlers.current.go(1);
        else if (g.dx > w * 0.15 || g.vx > 0.4) handlers.current.go(-1);
        else handlers.current.springBack();
      },
      onPanResponderTerminate: () => handlers.current.springBack(),
    }),
  ).current;

  // ---- drawing ----

  const renderPage = (data: { laid: Laid; page: Page } | undefined, placeholder?: string) => {
    if (!data) {
      return (
        <View style={styles.center}>
          {placeholder ? <Text style={{ color: theme.muted, textAlign: 'center' }}>{placeholder}</Text> : <ActivityIndicator color={theme.muted} />}
        </View>
      );
    }
    const { laid: l, page } = data;
    return page.items.map((it) => {
      const k = it.b - l.first;
      const blk = l.blocks[k];
      if (!blk) return null;
      if (blk.k === 'img') return <BlockImage key={it.b} book={book} imageKey={blk.s!} width={width} height={it.h} />;
      if (blk.k === 'sp' || blk.k === 'hr') return <Spacer key={it.b} block={blk} settings={settings} theme={theme} />;
      const m = l.measures[k];
      const len = m.kind === 'text' ? m.length : 0;
      return (
        <BlockText
          key={`${it.b}:${it.s}`}
          block={blk}
          look={l.looks[k]}
          theme={theme}
          range={[it.s, it.e]}
          noTopMargin={it.top || it.s > 0}
          noBottomMargin={it.e < len}
        />
      );
    });
  };

  const current = cur.page !== null && curLaid ? { laid: curLaid, page: curLaid.pages[cur.page] } : undefined;
  const prev = neighbour(-1);
  const next = neighbour(1);
  const processingMsg = `Still preparing the rest of this book… ${Math.round(book.progress * 100)}%`;
  /** A stable identity for what a strip position shows. */
  const pageKey = (n: ReturnType<typeof neighbour>): string | null => {
    if (n === 'processing') return 'processing';
    if (!n || n === 'end') return null;
    return n.cur.page === null ? `pending:${n.cur.chunk}` : `p:${n.cur.chunk}:${n.cur.page}`;
  };
  const strip: { key: string; at: number; content: ReturnType<typeof renderPage> }[] = [];
  const prevKey = pageKey(prev);
  const nextKey = pageKey(next);
  if (prevKey && prev !== 'end' && prev) strip.push({ key: prevKey, at: slot - 1, content: prev === 'processing' ? renderPage(undefined, processingMsg) : renderPage(prev.pageData) });
  strip.push({ key: cur.page === null ? `pending:${cur.chunk}` : `p:${cur.chunk}:${cur.page}`, at: slot, content: renderPage(current) });
  if (nextKey && next !== 'end' && next) strip.push({ key: nextKey, at: slot + 1, content: next === 'processing' ? renderPage(undefined, processingMsg) : renderPage(next.pageData) });

  const firstItem = current?.page.items[0];
  const chapter = firstItem ? book.chapterAt(firstItem.b)?.t : undefined;
  const pct = firstItem ? book.fraction(lastPos.current) * 100 : 0;

  return (
    <View style={[styles.root, { backgroundColor: theme.bg, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={[styles.header, { paddingHorizontal: settings.margin }]}>
        <Text numberOfLines={1} style={[styles.meta, { color: theme.muted }]}>
          {chapter ?? book.entry.title}
        </Text>
      </View>
      <View style={styles.viewport} {...pan.panHandlers}>
        {strip.map(({ key, at, content }) => (
          <Animated.View
            key={key}
            style={[
              styles.page,
              { width: win.width, height: pageHeight, paddingHorizontal: settings.margin, backgroundColor: theme.bg },
              { transform: [{ translateX: Animated.add(shift, at * win.width) }] },
            ]}>
            {content}
          </Animated.View>
        ))}
        {measuring && (
          <View style={{ position: 'absolute', left: settings.margin, top: 0 }}>
            <Measurer
              key={`${measuring.chunk}|${measuring.key}`}
              book={book}
              blocks={measuring.blocks}
              settings={settings}
              theme={theme}
              width={width}
              pageHeight={pageHeight}
              onDone={(m, l) => onMeasured(measuring.chunk, measuring.blocks, measuring.key, m, l)}
            />
          </View>
        )}
      </View>
      <View style={[styles.footer, { paddingHorizontal: settings.margin }]}>
        <Text style={[styles.meta, { color: theme.muted }]}>
          {book.complete ? `${pct.toFixed(1)}%` : `${pct.toFixed(1)}% · preparing ${Math.round(book.progress * 100)}%`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { height: HEADER, justifyContent: 'center', alignItems: 'center' },
  footer: { height: FOOTER, alignItems: 'center', justifyContent: 'center' },
  meta: { fontSize: 12 },
  viewport: { flex: 1, overflow: 'hidden' },
  page: { position: 'absolute', left: 0, top: 0, overflow: 'hidden' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
});
