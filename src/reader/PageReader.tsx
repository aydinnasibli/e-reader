// Page mode. Only the current chunk and its neighbours are ever laid out, so
// turning pages costs the same on page 3 of a pamphlet and page 30,000 of a
// 100 MB book.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, Animated, PanResponder, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Block, Position } from '@/engine/types';
import type { ReaderSettings, Theme } from '@/lib/settings';
import type { BookData } from './book';
import { BlockImage, BlockText, Spacer } from './BlockText';
import { Measurer } from './Measurer';
import { type Look, layoutKeyOf } from './look';
import type { Mark } from './marks';
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
  /** Called with the first and last position shown. */
  onPosition(pos: Position, end?: Position): void;
  onTap(): void;
  /** Highlights and search hits for a block. */
  marksFor?(b: number): Mark[] | undefined;
  /** Long-press on a paragraph. */
  onLongPressBlock?(b: number): void;
  bookmarked?: boolean;
  /** Small text shown at the bottom right (e.g. time left). */
  footerRight?: string;
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

export function PageReader({ book, settings, theme, start, startKey, version, onPosition, onTap, marksFor, onLongPressBlock, bookmarked, footerRight }: Props) {
  const win = useWindowDimensions();
  const liveInsets = useSafeAreaInsets();
  // Showing/hiding the status bar can change the insets on some iPhones; that
  // must not re-paginate the book, so they are only re-read when the window changes.
  const insets = useMemo(() => liveInsets, [win.width, win.height]); // eslint-disable-line react-hooks/exhaustive-deps
  const width = win.width - settings.margin * 2;
  const pageHeight = Math.floor(win.height - insets.top - insets.bottom - HEADER - FOOTER);
  const layoutKey = `${width}|${pageHeight}|${layoutKeyOf(settings)}`;

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
    const items = curLaid.pages[cur.page].items;
    const last = items[items.length - 1];
    const lastPrefix = curLaid.looks[last.b - curLaid.first]?.prefix.length ?? 0;
    lastPos.current = pos;
    onPosition(pos, { b: last.b, o: Math.max(0, last.e - lastPrefix) });
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
  const fade = useRef(new Animated.Value(1)).current;
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
    const land = () => {
      if (n.cur.page === null) target.current = { pos: { b: book.chunkStart(n.cur.chunk), o: 0 }, last: dir < 0 };
      setSlot(nextSlot);
      setCur(n.cur);
      animating.current = false;
    };
    if (settings.pageTurn === 'slide') {
      Animated.parallel([
        Animated.timing(base, { toValue: -nextSlot * win.width, duration: 220, useNativeDriver: true }),
        Animated.timing(drag, { toValue: 0, duration: 220, useNativeDriver: true }),
      ]).start(land);
    } else if (settings.pageTurn === 'fade') {
      // Dip to the background colour, switch, fade back in.
      Animated.timing(fade, { toValue: 0, duration: 110, useNativeDriver: true }).start(() => {
        drag.setValue(0);
        base.setValue(-nextSlot * win.width);
        land();
        Animated.timing(fade, { toValue: 1, duration: 140, useNativeDriver: true }).start();
      });
    } else {
      drag.setValue(0);
      base.setValue(-nextSlot * win.width);
      land();
    }
  };
  // Keep the strip aligned if the window size changes.
  useEffect(() => {
    base.setValue(-slot * win.width);
  }, [win.width]); // eslint-disable-line react-hooks/exhaustive-deps

  // Where each item of each visible page sits, for long-press hit testing.
  const itemBoxes = useRef(new Map<string, { b: number; y: number; h: number }>());
  const viewportTop = useRef(0);
  const viewportRef = useRef<View>(null);
  const curKeyRef = useRef('');
  const blockAt = (pageY: number): number | null => {
    const y = pageY - viewportTop.current;
    for (const [k, box] of itemBoxes.current) {
      if (k.startsWith(curKeyRef.current + '|') && y >= box.y && y < box.y + box.h) return box.b;
    }
    return null;
  };
  const longPress = (pageY: number) => {
    const b = blockAt(pageY);
    if (b !== null) onLongPressBlock?.(b);
  };

  const handlers = useRef<{
    go(d: 1 | -1): void;
    onTap(): void;
    springBack(): void;
    longPress(pageY: number): void;
    width: number;
    follow: boolean;
    tapForward: boolean;
    canGo(d: 1 | -1): boolean;
  }>({
    go,
    onTap,
    springBack,
    longPress,
    width: win.width,
    follow: true,
    tapForward: false,
    canGo: () => true,
  });
  handlers.current = {
    go,
    onTap,
    springBack,
    longPress,
    width: win.width,
    follow: settings.pageTurn === 'slide',
    tapForward: settings.tapForward,
    canGo: (d) => {
      const n = neighbour(d);
      return !!n && n !== 'end' && n !== 'processing';
    },
  };
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean }>({ timer: null, fired: false });
  const cancelPress = () => {
    if (press.current.timer) clearTimeout(press.current.timer);
    press.current.timer = null;
  };
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderGrant: (e) => {
        const pageY = e.nativeEvent.pageY;
        press.current.fired = false;
        cancelPress();
        press.current.timer = setTimeout(() => {
          press.current.timer = null;
          press.current.fired = true;
          handlers.current.longPress(pageY);
        }, 450);
      },
      onPanResponderMove: (_e, g) => {
        if (Math.abs(g.dx) > 8 || Math.abs(g.dy) > 8) cancelPress();
        if (press.current.fired || !handlers.current.follow) return;
        const dir = g.dx < 0 ? 1 : -1;
        drag.setValue(handlers.current.canGo(dir) ? g.dx : g.dx * 0.25);
      },
      onPanResponderRelease: (e, g) => {
        cancelPress();
        if (press.current.fired) return;
        const w = handlers.current.width;
        if (Math.abs(g.dx) < 8 && Math.abs(g.dy) < 8) {
          const tx = e.nativeEvent.pageX;
          if (tx < w * 0.3) handlers.current.go(handlers.current.tapForward ? 1 : -1);
          else if (tx > w * 0.7) handlers.current.go(1);
          else handlers.current.onTap();
          return;
        }
        if (g.dx < -w * 0.15 || g.vx < -0.4) handlers.current.go(1);
        else if (g.dx > w * 0.15 || g.vx > 0.4) handlers.current.go(-1);
        else handlers.current.springBack();
      },
      onPanResponderTerminate: () => {
        cancelPress();
        handlers.current.springBack();
      },
    }),
  ).current;

  // ---- drawing ----

  const renderPage = (data: { laid: Laid; page: Page } | undefined, placeholder?: string, key = '') => {
    if (!data) {
      return (
        <View style={styles.center}>
          {placeholder ? <Text style={{ color: theme.muted, textAlign: 'center' }}>{placeholder}</Text> : <ActivityIndicator color={theme.muted} />}
        </View>
      );
    }
    const { laid: l, page } = data;
    return page.items.map((it, idx) => {
      const k = it.b - l.first;
      const blk = l.blocks[k];
      if (!blk) return null;
      let content;
      if (blk.k === 'img') content = <BlockImage book={book} imageKey={blk.s!} width={width} height={it.h} />;
      else if (blk.k === 'sp' || blk.k === 'hr') content = <Spacer block={blk} settings={settings} theme={theme} />;
      else {
        const m = l.measures[k];
        const len = m.kind === 'text' ? m.length : 0;
        content = (
          <BlockText
            block={blk}
            look={l.looks[k]}
            theme={theme}
            range={[it.s, it.e]}
            noTopMargin={it.top || it.s > 0}
            noBottomMargin={it.e < len}
            marks={marksFor?.(it.b)}
          />
        );
      }
      const boxKey = `${key}|${idx}`;
      return (
        <View
          key={`${it.b}:${it.s}`}
          onLayout={(e) => itemBoxes.current.set(boxKey, { b: it.b, y: e.nativeEvent.layout.y, h: e.nativeEvent.layout.height })}>
          {content}
        </View>
      );
    });
  };

  const current = cur.page !== null && curLaid ? { laid: curLaid, page: curLaid.pages[cur.page] } : undefined;
  // While a new layout is being measured (settings changed, or a jump), keep
  // showing the last page instead of a blank one.
  const lastShown = useRef<typeof current>(undefined);
  if (current) lastShown.current = current;
  const shown = current ?? lastShown.current;
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
  const curKey = cur.page === null ? `pending:${cur.chunk}` : `p:${cur.chunk}:${cur.page}`;
  curKeyRef.current = curKey;
  if (prevKey && prev !== 'end' && prev)
    strip.push({ key: prevKey, at: slot - 1, content: prev === 'processing' ? renderPage(undefined, processingMsg) : renderPage(prev.pageData, undefined, prevKey) });
  strip.push({ key: curKey, at: slot, content: renderPage(shown, undefined, curKey) });
  if (nextKey && next !== 'end' && next)
    strip.push({ key: nextKey, at: slot + 1, content: next === 'processing' ? renderPage(undefined, processingMsg) : renderPage(next.pageData, undefined, nextKey) });
  // Forget boxes of pages that are no longer on the strip.
  for (const k of itemBoxes.current.keys()) if (!strip.some((p) => k.startsWith(p.key + '|'))) itemBoxes.current.delete(k);

  const firstItem = current?.page.items[0];
  const chapter = firstItem ? book.chapterAt(firstItem.b)?.t : undefined;
  const pct = firstItem ? book.fraction(lastPos.current) * 100 : 0;

  return (
    <View style={[styles.root, { backgroundColor: theme.bg, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={[styles.header, { paddingHorizontal: settings.margin + 22 }]}>
        <Text numberOfLines={1} style={[styles.meta, { color: theme.muted }]}>
          {chapter ?? book.entry.title}
        </Text>
        {bookmarked ? <Ionicons name="bookmark" size={20} color={theme.accent} style={styles.ribbon} /> : null}
      </View>
      <View
        ref={viewportRef}
        style={styles.viewport}
        onLayout={() => viewportRef.current?.measureInWindow((_x, y) => (viewportTop.current = y))}
        {...pan.panHandlers}>
        {strip.map(({ key, at, content }) => (
          <Animated.View
            key={key}
            style={[
              styles.page,
              { width: win.width, height: pageHeight, paddingHorizontal: settings.margin, backgroundColor: theme.bg },
              { opacity: fade, transform: [{ translateX: Animated.add(shift, at * win.width) }] },
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
        <Text style={[styles.meta, { color: theme.muted }]}>{footerRight ?? ''}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { height: HEADER, justifyContent: 'center', alignItems: 'center' },
  footer: { height: FOOTER, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  ribbon: { position: 'absolute', right: 10, top: 2 },
  meta: { fontSize: 12 },
  viewport: { flex: 1, overflow: 'hidden' },
  page: { position: 'absolute', left: 0, top: 0, overflow: 'hidden' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
});
