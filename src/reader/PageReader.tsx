// Page mode. Only the current chunk and its neighbours are ever laid out, so
// turning pages costs the same on page 3 of a pamphlet and page 30,000 of a
// 100 MB book.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, Animated, PanResponder, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Block, Position } from '@/engine/types';
import type { ReaderSettings, Theme } from '@/lib/settings';
import type { BookData } from './book';
import { BlockImage, BlockText, Spacer } from './BlockText';
import { Measurer } from './Measurer';
import { hitText } from './hitTest';
import { type Look, drawn, layoutKeyOf, toBlock, toDrawn } from './look';
import type { Mark } from './marks';
import { type Measure, type Page, type PageItem, pageOf, paginate } from './paginate';

export const HEADER = 30;
export const FOOTER = 30;

type Insets = { top: number; bottom: number; left: number; right: number };

/**
 * Size of a page (one column of a spread) for a window, safe-area insets and
 * margin. `left` is where text starts (clear of a landscape notch).
 */
export function pageFrame(win: { width: number; height: number }, insets: Insets, margin: number) {
  // Landscape on a wide screen: two pages side by side, turned together.
  const spread = win.width > win.height && win.width >= 640;
  const usable = win.width - insets.left - insets.right;
  const width = spread ? Math.floor((usable - margin * 3) / 2) : usable - margin * 2;
  const pageHeight = Math.floor(win.height - insets.top - insets.bottom - HEADER - FOOTER);
  return { spread, width, pageHeight, left: insets.left + margin };
}

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
  /** Long-press on a paragraph, with the character offset pressed (when known). */
  onLongPressBlock?(b: number, at?: number): void;
  /** Tap on a footnote reference. */
  onLink?(target: string): void;
  bookmarked?: boolean;
  /** Small text shown at the bottom right (e.g. time left). */
  footerRight?: string;
  /** Called with the layout key once a page of that layout is on screen. */
  onLayoutReady?(key: string): void;
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

export function PageReader({ book, settings, theme, start, startKey, version, onPosition, onTap, marksFor, onLongPressBlock, onLink, bookmarked, footerRight, onLayoutReady }: Props) {
  const win = useWindowDimensions();
  const liveInsets = useSafeAreaInsets();
  // Showing/hiding the status bar can change the top inset on some iPhones;
  // that must not re-paginate the book, so insets are re-read only when the
  // window or the side insets change (rotation).
  const insets = useMemo(() => liveInsets, [win.width, win.height, liveInsets.left, liveInsets.right]); // eslint-disable-line react-hooks/exhaustive-deps
  const { spread, width, pageHeight, left: textLeft } = pageFrame(win, insets, settings.margin);
  const step = spread ? 2 : 1;
  const spreadStart = (p: number) => (spread ? p - (p % 2) : p);
  const layoutKey = `${width}|${pageHeight}|${layoutKeyOf(settings)}`;

  // Laid-out chunks for the current layout.
  const laid = useMemo(() => new Map<number, Laid>(), [layoutKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [, setTick] = useState(0);
  const [cur, setCur] = useState<Cur>(() => ({ chunk: book.chunkOf(start.b), page: null }));
  const target = useRef<{ pos: Position; last?: boolean }>({ pos: start });
  const lastPos = useRef<Position>(start);
  const [measuring, setMeasuring] = useState<{ chunk: number; blocks: Block[]; key: string } | null>(null);

  // Whether the last page may stay on screen while the current one is laid out.
  const staleOk = useRef(false);
  // Jump requests (TOC, slider) and layout changes both re-target the reader.
  useEffect(() => {
    target.current = { pos: start };
    staleOk.current = false;
    setCur({ chunk: book.chunkOf(start.b), page: null });
  }, [startKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    target.current = { pos: lastPos.current };
    staleOk.current = true;
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

  // Reopening a book that is being converted again (after a crash, or
  // "Prepare it again"): the saved place may not be converted yet. Wait for it
  // instead of showing (and saving) the last page that exists so far.
  const waitingForPlace = cur.page === null && !target.current.last && !book.complete && target.current.pos.b >= book.totalBlocks;
  useEffect(() => {
    if (cur.page !== null) return;
    const c = book.chunkOf(target.current.pos.b);
    if (c !== cur.chunk && !target.current.last) setCur({ chunk: c, page: null });
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve a pending target once its chunk is laid out.
  const curLaid = laid.get(cur.chunk);
  useEffect(() => {
    if (cur.page !== null || !curLaid || waitingForPlace) return;
    const t = target.current;
    // Only resolve inside the chunk that holds the target (it may just have moved on).
    if (!t.last && book.chunkOf(t.pos.b) !== cur.chunk) return;
    let page: number;
    if (t.last) page = curLaid.pages.length - 1;
    else {
      const k = t.pos.b - curLaid.first;
      const blk = curLaid.blocks[k];
      const at = blk && t.pos.o > 0 ? toDrawn(drawn(blk, curLaid.looks[k]), t.pos.o) : 0;
      page = pageOf(curLaid.pages, t.pos.b, at);
    }
    setCur({ chunk: cur.chunk, page: spreadStart(page) });
  }, [cur, curLaid, waitingForPlace]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the chunks around the current one in the book's memory (search hits
  // and the slider can visit many), and forget layouts far away.
  useEffect(() => {
    for (const c of [cur.chunk, cur.chunk + 1, cur.chunk - 1]) if (c >= 0 && c < book.chunkCount) void book.loadChunk(c);
    for (const c of laid.keys()) if (Math.abs(c - cur.chunk) > 2) laid.delete(c);
  }, [cur.chunk, laid, book]);

  // Report the reading position.
  useEffect(() => {
    if (cur.page === null || !curLaid) return;
    const item = curLaid.pages[cur.page]?.items[0];
    if (!item) return;
    const bookOffset = (b: number, i: number) => {
      const k = b - curLaid.first;
      const blk = curLaid.blocks[k];
      return blk ? toBlock(drawn(blk, curLaid.looks[k]), i) : 0;
    };
    const pos = { b: item.b, o: bookOffset(item.b, item.s) };
    const items = (curLaid.pages[cur.page + step - 1] ?? curLaid.pages[cur.page]).items;
    const last = items[items.length - 1];
    lastPos.current = pos;
    // The end is exclusive: where the next page starts.
    const lastText = curLaid.measures[last.b - curLaid.first]?.kind === 'text';
    onPosition(pos, lastText ? { b: last.b, o: bookOffset(last.b, last.e) } : { b: last.b + 1, o: 0 });
  }, [cur, curLaid, onPosition, step]);

  /** The page one step away, or why there isn't one. */
  const neighbour = (dir: 1 | -1): { cur: Cur; pageData?: { laid: Laid; index: number } } | 'end' | 'processing' | null => {
    if (cur.page === null || !curLaid) return null;
    const p = cur.page + dir * step;
    if (p >= 0 && p < curLaid.pages.length) return { cur: { chunk: cur.chunk, page: p }, pageData: { laid: curLaid, index: p } };
    const c = cur.chunk + dir;
    if (c < 0) return 'end';
    if (c >= book.chunkCount) return book.complete ? 'end' : 'processing';
    const l = laid.get(c);
    if (!l) return { cur: { chunk: c, page: null } };
    const np = dir > 0 ? 0 : spreadStart(l.pages.length - 1);
    return { cur: { chunk: c, page: np }, pageData: { laid: l, index: np } };
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
    const keyAtStart = layoutKey;
    const land = () => {
      animating.current = false;
      setSlot(nextSlot);
      base.setValue(-nextSlot * widthRef.current);
      // Rotated or resized mid-turn: the page indices belong to the old layout,
      // which the layout change has already re-targeted.
      if (layoutKeyRef.current !== keyAtStart) return;
      staleOk.current = false;
      if (n.cur.page === null) target.current = { pos: { b: book.chunkStart(n.cur.chunk), o: 0 }, last: dir < 0 };
      setCur(n.cur);
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
  const layoutKeyRef = useRef(layoutKey);
  layoutKeyRef.current = layoutKey;
  const widthRef = useRef(win.width);
  widthRef.current = win.width;
  // Keep the strip aligned if the window size changes.
  useEffect(() => {
    base.setValue(-slot * win.width);
  }, [win.width]); // eslint-disable-line react-hooks/exhaustive-deps

  // Where each item of each visible page sits, for long-press hit testing.
  const itemBoxes = useRef(new Map<string, { y: number; h: number; it: PageItem; laid: Laid }>());
  const viewportTop = useRef(0);
  const viewportRef = useRef<View>(null);
  /** The block and character under a point within one page column (`column` is that column's key). */
  const longPress = (pageX: number, pageY: number, column: string) => {
    const y = pageY - viewportTop.current;
    for (const [k, box] of itemBoxes.current) {
      if (!k.startsWith(column + '|') || y < box.y || y >= box.y + box.h) continue;
      const { it, laid: l } = box;
      const i = it.b - l.first;
      const blk = l.blocks[i];
      const m = l.measures[i];
      const look = l.looks[i];
      if (!blk || m?.kind !== 'text') return onLongPressBlock?.(it.b);
      const top = it.top || it.s > 0 ? 0 : look.marginTop;
      const left = textLeft + (column.endsWith(':R') ? width + settings.margin : 0) + look.paddingLeft;
      const d = drawn(blk, look);
      const at = hitText(d.text, m.lines, it.s, it.e, pageX - left, y - box.y - top, width - look.paddingLeft, look.textAlign === 'justify');
      return onLongPressBlock?.(it.b, toBlock(d, at));
    }
  };

  // The pan responder is created once; it reads the latest values from here.
  const handlers = useRef<{ go(d: 1 | -1): void; springBack(): void; width: number; follow: boolean; canGo(d: 1 | -1): boolean }>({
    go,
    springBack,
    width: win.width,
    follow: true,
    canGo: () => true,
  });
  handlers.current = {
    go,
    springBack,
    width: win.width,
    follow: settings.pageTurn === 'slide',
    canGo: (d) => {
      const n = neighbour(d);
      return !!n && n !== 'end' && n !== 'processing';
    },
  };
  // Swipes are taken by the page strip; taps and long-presses go to whatever
  // is under the finger (a footnote link, or the page itself).
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponderCapture: (_e, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_e, g) => {
        if (!handlers.current.follow) return;
        const dir = g.dx < 0 ? 1 : -1;
        drag.setValue(handlers.current.canGo(dir) ? g.dx : g.dx * 0.25);
      },
      onPanResponderRelease: (_e, g) => {
        const w = handlers.current.width;
        if (g.dx < -w * 0.15 || g.vx < -0.4) handlers.current.go(1);
        else if (g.dx > w * 0.15 || g.vx > 0.4) handlers.current.go(-1);
        else handlers.current.springBack();
      },
      onPanResponderTerminate: () => handlers.current.springBack(),
    }),
  ).current;
  const tapPage = (pageX: number) => {
    const w = win.width;
    if (pageX < w * 0.3) go(settings.tapForward ? 1 : -1);
    else if (pageX > w * 0.7) go(1);
    else onTap();
  };

  // ---- drawing ----

  /** One page view: a single page, or two pages side by side in a spread. */
  const renderPage = (data: { laid: Laid; index: number } | undefined, placeholder?: string, key = '') => {
    if (!data) {
      return (
        <View style={styles.center}>
          {placeholder ? <Text style={{ color: theme.muted, textAlign: 'center' }}>{placeholder}</Text> : <ActivityIndicator color={theme.muted} />}
        </View>
      );
    }
    const column = (page: Page | undefined, colKey: string) => (
      <Pressable
        key={colKey}
        style={spread ? { width } : styles.fill}
        onPress={(e) => tapPage(e.nativeEvent.pageX)}
        onLongPress={(e) => longPress(e.nativeEvent.pageX, e.nativeEvent.pageY, colKey)}
        delayLongPress={450}>
        {page ? renderItems(data.laid, page, colKey) : null}
      </Pressable>
    );
    if (!spread) return column(data.laid.pages[data.index], key);
    return (
      <View style={[styles.row, { gap: settings.margin }]}>
        {column(data.laid.pages[data.index], `${key}:L`)}
        {column(data.laid.pages[data.index + 1], `${key}:R`)}
      </View>
    );
  };

  const renderItems = (l: Laid, page: Page, key: string) => {
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
            onLink={onLink}
          />
        );
      }
      const boxKey = `${key}|${idx}`;
      return (
        <View
          key={`${it.b}:${it.s}`}
          onLayout={(e) => itemBoxes.current.set(boxKey, { y: e.nativeEvent.layout.y, h: e.nativeEvent.layout.height, it, laid: l })}>
          {content}
        </View>
      );
    });
  };

  const current = cur.page !== null && curLaid && curLaid.pages[cur.page] ? { laid: curLaid, index: cur.page } : undefined;
  const ready = !!current;
  useEffect(() => {
    if (ready) onLayoutReady?.(layoutKey);
  }, [ready, layoutKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // While a new layout is being measured (settings changed, or a jump), keep
  // showing the last page instead of a blank one.
  const lastShown = useRef<typeof current>(undefined);
  if (current) lastShown.current = current;
  // Only while re-laying out for new settings; after a turn into a chunk that
  // isn't measured yet, the old page would look like the turn didn't happen.
  const shown = current ?? (staleOk.current ? lastShown.current : undefined);
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
  if (prevKey && prev !== 'end' && prev)
    strip.push({ key: prevKey, at: slot - 1, content: prev === 'processing' ? renderPage(undefined, processingMsg) : renderPage(prev.pageData, undefined, prevKey) });
  const waitMsg = `Preparing the book up to where you left off… ${Math.round(book.progress * 100)}%`;
  strip.push({ key: curKey, at: slot, content: waitingForPlace ? renderPage(undefined, waitMsg) : renderPage(shown, undefined, curKey) });
  if (nextKey && next !== 'end' && next)
    strip.push({ key: nextKey, at: slot + 1, content: next === 'processing' ? renderPage(undefined, processingMsg) : renderPage(next.pageData, undefined, nextKey) });
  // Forget boxes of pages that are no longer on the strip.
  for (const k of itemBoxes.current.keys()) if (!strip.some((p) => k.startsWith(p.key + '|') || k.startsWith(p.key + ':'))) itemBoxes.current.delete(k);

  const firstItem = current?.laid.pages[current.index].items[0];
  const chapter = firstItem ? book.chapterAt(firstItem.b)?.t : undefined;
  const pct = firstItem ? book.fraction(lastPos.current) * 100 : 0;

  return (
    <View style={[styles.root, { backgroundColor: theme.bg, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={[styles.header, { paddingLeft: textLeft + 22, paddingRight: settings.margin + insets.right + 22 }]}>
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
              { width: win.width, height: pageHeight, paddingLeft: textLeft, paddingRight: settings.margin + insets.right, backgroundColor: theme.bg },
              { opacity: fade, transform: [{ translateX: Animated.add(shift, at * win.width) }] },
            ]}>
            {content}
          </Animated.View>
        ))}
        {measuring && (
          <View style={{ position: 'absolute', left: textLeft, top: 0 }}>
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
      <View style={[styles.footer, { paddingLeft: textLeft, paddingRight: settings.margin + insets.right }]}>
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
  fill: { flex: 1 },
  row: { flex: 1, flexDirection: 'row' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
});
