// Continuous scroll mode. The list holds a sliding window of a few chunks and
// grows or shrinks it at the edges as you scroll, so the list never holds the
// whole book.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, type TextLayoutEvent, View, type ViewToken, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Block, Position } from '@/engine/types';
import type { ReaderSettings, Theme } from '@/lib/settings';
import type { BookData } from './book';
import { ClockBattery } from './StatusInfo';
import { BlockImage, BlockText, Spacer } from './BlockText';
import { hitText } from './hitTest';
import { drawn, lookOf, toBlock } from './look';
import type { Mark } from './marks';
import { type Line, lineRanges } from './paginate';
import type { TextPoint } from './selection';

const MAX_WINDOW_CHUNKS = 8;

interface Props {
  book: BookData;
  settings: ReaderSettings;
  theme: Theme;
  start: Position;
  startKey: number;
  version: number;
  onPosition(pos: Position): void;
  onTap(): void;
  marksFor?(b: number): Mark[] | undefined;
  onLongPressBlock?(b: number, at?: number): void;
  onLink?(target: string): void;
  footerRight?: string;
  /** Highlight tool on: scrolling pauses and dragging over text reports the range. */
  highlighting?: boolean;
  onHighlightDrag?(from: TextPoint | null, to: TextPoint | null, done: boolean): void;
  onHighlightTap?(at: TextPoint): void;
  /** Auto-scroll speed in points per second; 0 or missing = off. */
  autoScroll?: number;
  /** The reader touched the list while it was auto-scrolling. */
  onAutoInterrupt?(): void;
  /** Auto-scroll reached the end of the book. */
  onAutoEnd?(): void;
  /** The end of the book came into view. */
  onReachEnd?(): void;
}

/** How far auto-scroll may ask to be ahead of where the list really is, in points. */
const MAX_LEAD = 120;
/** Further apart than auto-scroll can be ahead: the content moved under the list; start again from where it is. */
const RESYNC = MAX_LEAD + 80;

interface Win {
  first: number; // first chunk in the window
  last: number; // last chunk in the window
  start: number; // first block shown
}

export function ScrollReader({ book, settings, theme, start, startKey, version, onPosition, onTap, marksFor, onLongPressBlock, onLink, footerRight, highlighting, onHighlightDrag, onHighlightTap, autoScroll, onAutoInterrupt, onAutoEnd, onReachEnd }: Props) {
  const win = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // Clear of a landscape notch on either side.
  const padLeft = settings.margin + insets.left;
  const padRight = settings.margin + insets.right;
  const width = win.width - padLeft - padRight;
  const blocks = useRef(new Map<number, Block[]>()).current;
  const [w, setW] = useState<Win | null>(null);
  const busy = useRef(false);
  const [pos, setPos] = useState<Position>(start);

  // Loads started before a jump must not land in the new window.
  const generation = useRef(0);
  // Reopening a book being converted again: wait until the saved place exists.
  const waiting = !book.complete && start.b >= book.totalBlocks;

  // Open at `start` (and again on every jump).
  useEffect(() => {
    let alive = true;
    const gen = ++generation.current;
    blocks.clear();
    setW(null);
    busy.current = false;
    // The list starts over at the top: auto-scroll must not carry on from the old place.
    actual.current = 0;
    offset.current = 0;
    if (waiting) return;
    const c = book.chunkOf(start.b);
    book.loadChunk(c).then((bl) => {
      if (!alive || gen !== generation.current) return;
      blocks.set(c, bl);
      setW({ first: c, last: c, start: start.b });
    });
    return () => {
      alive = false;
    };
  }, [startKey, waiting]); // eslint-disable-line react-hooks/exhaustive-deps

  const data = useMemo(() => {
    if (!w) return [];
    const end = book.chunkEnd(w.last);
    const out: number[] = [];
    for (let b = w.start; b < end; b++) out.push(b);
    return out;
  }, [w, book, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const extendEnd = useCallback(() => {
    if (!w || busy.current || w.last + 1 >= book.chunkCount) return;
    busy.current = true;
    const c = w.last + 1;
    const gen = generation.current;
    book.loadChunk(c).then((bl) => {
      if (gen !== generation.current) return;
      blocks.set(c, bl);
      busy.current = false;
      setW((cur) => {
        if (!cur) return cur;
        let { first, start: s } = cur;
        if (c - first + 1 > MAX_WINDOW_CHUNKS) {
          blocks.delete(first);
          first++;
          s = Math.max(s, book.chunkStart(first));
        }
        return { first, last: c, start: s };
      });
    });
  }, [w, book, blocks]);

  const extendStart = useCallback(() => {
    if (!w || busy.current) return;
    if (w.start > book.chunkStart(w.first)) {
      // Show the rest of the first chunk.
      setW({ ...w, start: book.chunkStart(w.first) });
      return;
    }
    if (w.first === 0) return;
    busy.current = true;
    const c = w.first - 1;
    const gen = generation.current;
    book.loadChunk(c).then((bl) => {
      if (gen !== generation.current) return;
      blocks.set(c, bl);
      busy.current = false;
      setW((cur) => {
        if (!cur) return cur;
        let last = cur.last;
        if (last - c + 1 > MAX_WINDOW_CHUNKS) {
          blocks.delete(last);
          last--;
        }
        return { first: c, last, start: book.chunkStart(c) };
      });
    });
  }, [w, book, blocks]);

  // A book that is still converting keeps growing; pull new text in if we're at the end.
  useEffect(() => {
    if (w && w.last === book.chunkCount - 2) extendEnd();
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  const positionRef = useRef(onPosition);
  positionRef.current = onPosition;
  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken<number>[] }) => {
    const first = viewableItems.find((v) => v.isViewable);
    if (first && typeof first.item === 'number') {
      const p = { b: first.item, o: 0 };
      setPos(p);
      positionRef.current(p);
    }
  }).current;

  const touch = useRef({ x: 0, y: 0, t: 0 });
  // A tap on a footnote link must not also toggle the menu.
  const lastLink = useRef(0);
  const linkPressed = useCallback(
    (target: string) => {
      lastLink.current = Date.now();
      onLink?.(target);
    },
    [onLink],
  );

  // Line layout of each shown paragraph, and its view, for finding the word
  // under a long-press.
  const lines = useRef(new Map<number, Line[]>()).current;
  const views = useRef(new Map<number, View>()).current;
  // One stable callback per paragraph (BlockText is memoized); it reads the
  // current settings when called, since a new layout reports new lines.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onLayoutFns = useRef(new Map<number, (e: TextLayoutEvent) => void>()).current;
  const layoutFn = (b: number, blk: Block) => {
    let f = onLayoutFns.get(b);
    if (!f) {
      f = (e) => lines.set(b, lineRanges(drawn(blk, lookOf(blk, settingsRef.current, book.manifest?.lang)).text, e.nativeEvent.lines));
      onLayoutFns.set(b, f);
    }
    return f;
  };
  const longPress = (b: number, blk: Block, pageX: number, pageY: number) => {
    const look = lookOf(blk, settings, book.manifest?.lang);
    const ls = lines.get(b);
    const view = views.get(b);
    if (!blk.r || !ls || !view) return onLongPressBlock?.(b);
    view.measureInWindow((x, y) => {
      const d = drawn(blk, look);
      const at = hitText(d.text, ls, 0, d.text.length, pageX - x - padLeft - look.paddingLeft, pageY - y - look.marginTop, width - look.paddingLeft, look.textAlign === 'justify');
      onLongPressBlock?.(b, toBlock(d, at));
    });
  };

  // ---- auto-scroll ----
  const list = useRef<FlatList<number>>(null);
  const offset = useRef(0);
  /** Where the list really is (it stops at the end of what's loaded). */
  const actual = useRef(0);
  /** The end of the book is loaded (set while drawing). */
  const endLoaded = useRef(false);
  const onAutoEndRef = useRef(onAutoEnd);
  onAutoEndRef.current = onAutoEnd;
  useEffect(() => {
    if (!autoScroll) return;
    let frame = 0;
    let last = Date.now();
    // When the list last moved: stuck at the end of the book means done.
    let moved = last;
    let seen = actual.current;
    offset.current = actual.current;
    const step = () => {
      const now = Date.now();
      // Any movement counts: trimming text above moves the list up, not down.
      if (Math.abs(actual.current - seen) > 0.5) {
        seen = actual.current;
        moved = now;
      } else if (endLoaded.current && now - moved > 1500) {
        onAutoEndRef.current?.();
        return;
      }
      // Frames can be late (busy JS thread): move by elapsed time, not per frame.
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      // Never run ahead of the list: at the end of the loaded text it can't
      // move, and new text arriving must not make it jump.
      offset.current = Math.min(offset.current + autoScroll * dt, actual.current + MAX_LEAD);
      list.current?.scrollToOffset({ offset: offset.current, animated: false });
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [autoScroll]);

  // ---- highlight tool ----
  // Scrolling is paused while it's on, so where each paragraph sits on screen
  // is measured once (and again if the list changes) and hit testing is instant.
  const rects = useRef(new Map<number, { x: number; y: number; h: number }>()).current;
  useEffect(() => {
    rects.clear();
    if (!highlighting) return;
    for (const [b, v] of views) v.measureInWindow((x, y, _w, h) => rects.set(b, { x, y, h }));
  }, [highlighting, data, settings, rects, views]);
  const blockAt = (b: number) => {
    const c = book.chunkOf(b);
    return blocks.get(c)?.[b - book.chunkStart(c)];
  };
  /** The text under a point; `nearest` uses the closest paragraph when between them. */
  const textPoint = (pageX: number, pageY: number, nearest: boolean): TextPoint | null => {
    let best = -1;
    let bestDist = Infinity;
    for (const [b, r] of rects) {
      if (!lines.has(b)) continue;
      const dist = pageY < r.y ? r.y - pageY : pageY >= r.y + r.h ? pageY - (r.y + r.h) + 1 : 0;
      if (dist < bestDist) {
        best = b;
        bestDist = dist;
      }
    }
    const blk = best >= 0 ? blockAt(best) : undefined;
    const r = rects.get(best);
    const ls = lines.get(best);
    if (!blk || !r || !ls || (!nearest && bestDist > 0)) return null;
    const look = lookOf(blk, settings, book.manifest?.lang);
    const d = drawn(blk, look);
    const at = hitText(d.text, ls, 0, d.text.length, pageX - r.x - padLeft - look.paddingLeft, pageY - r.y - look.marginTop, width - look.paddingLeft, look.textAlign === 'justify');
    return { b: best, o: toBlock(d, at) };
  };
  const stroke = useRef<{ x: number; y: number; from: TextPoint | null; moved: boolean }>({ x: 0, y: 0, from: null, moved: false });
  const highlightLayer = highlighting && (
    <View
      testID="highlight-layer"
      style={StyleSheet.absoluteFill}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        const { pageX, pageY } = e.nativeEvent;
        stroke.current = { x: pageX, y: pageY, from: textPoint(pageX, pageY, true), moved: false };
      }}
      onResponderMove={(e) => {
        const { pageX, pageY } = e.nativeEvent;
        const st = stroke.current;
        if (!st.moved && Math.hypot(pageX - st.x, pageY - st.y) < 8) return;
        st.moved = true;
        const to = textPoint(pageX, pageY, true);
        if (st.from && to) onHighlightDrag?.(st.from, to, false);
      }}
      onResponderRelease={(e) => {
        const { pageX, pageY } = e.nativeEvent;
        const st = stroke.current;
        if (st.moved) {
          const to = textPoint(pageX, pageY, true);
          onHighlightDrag?.(st.from, st.from && to ? to : null, true);
          return;
        }
        const p = textPoint(pageX, pageY, false);
        if (p) onHighlightTap?.(p);
      }}
      onResponderTerminate={() => onHighlightDrag?.(null, null, true)}
    />
  );

  const renderItem = ({ item: b }: { item: number }) => {
    const c = book.chunkOf(b);
    const blk = blocks.get(c)?.[b - book.chunkStart(c)];
    if (!blk) return null;
    let content;
    if (blk.k === 'img') content = <BlockImage book={book} imageKey={blk.s!} width={width} />;
    else if (blk.k === 'sp' || blk.k === 'hr') content = <Spacer block={blk} settings={settings} theme={theme} />;
    else {
      const look = lookOf(blk, settings, book.manifest?.lang);
      content = <BlockText block={blk} look={look} theme={theme} marks={marksFor?.(b)} onLink={linkPressed} onTextLayout={layoutFn(b, blk)} />;
    }
    return (
      <Pressable
        ref={(v) => {
          if (v) views.set(b, v);
          else {
            // Scrolled away: forget it, so long books don't pile up entries.
            views.delete(b);
            lines.delete(b);
            onLayoutFns.delete(b);
          }
        }}
        onLongPress={(e) => longPress(b, blk, e.nativeEvent.pageX, e.nativeEvent.pageY)}
        delayLongPress={450}
        style={{ paddingLeft: padLeft, paddingRight: padRight }}>
        {content}
      </Pressable>
    );
  };

  const atEnd = w ? w.last >= book.chunkCount - 1 : false;
  endLoaded.current = atEnd && book.complete;
  const pct = book.fraction(pos) * 100;

  return (
    <View
      style={[styles.root, { backgroundColor: theme.bg }]}
      onTouchStart={(e) => (touch.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, t: Date.now() })}
      onTouchEnd={(e) => {
        const t = touch.current;
        if (highlighting) return;
        if (Math.abs(e.nativeEvent.pageX - t.x) < 10 && Math.abs(e.nativeEvent.pageY - t.y) < 10 && Date.now() - t.t < 300) {
          // Link presses are delivered around the same time; check after they had their turn.
          setTimeout(() => Date.now() - lastLink.current > 400 && onTap(), 0);
        }
      }}>
      {waiting && (
        <Text style={[styles.end, { color: theme.muted, paddingTop: insets.top + 80 }]}>
          {`Preparing the book up to where you left off… ${Math.round(book.progress * 100)}%`}
        </Text>
      )}
      {w && (
        <FlatList
          ref={list}
          key={startKey}
          scrollEnabled={!highlighting}
          onScroll={(e) => {
            const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
            actual.current = contentOffset.y;
            if (endLoaded.current && contentOffset.y + layoutMeasurement.height >= contentSize.height - 40) onReachEnd?.();
            // Not auto-scrolling, or the content moved under it (text trimmed above): follow the list.
            if (!autoScroll || Math.abs(offset.current - actual.current) > RESYNC) offset.current = actual.current;
          }}
          scrollEventThrottle={32}
          onScrollBeginDrag={() => autoScroll && onAutoInterrupt?.()}
          data={data}
          keyExtractor={(b) => String(b)}
          renderItem={renderItem}
          extraData={[settings, theme, marksFor]}
          contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 40 }}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          onEndReached={extendEnd}
          onEndReachedThreshold={2}
          onStartReached={extendStart}
          onStartReachedThreshold={2}
          onViewableItemsChanged={onViewable}
          viewabilityConfig={{ itemVisiblePercentThreshold: 1 }}
          initialNumToRender={15}
          windowSize={9}
          ListFooterComponent={
            atEnd ? (
              <Text style={[styles.end, { color: theme.muted }]}>
                {book.complete ? '— The End —' : `Still preparing the rest of this book… ${Math.round(book.progress * 100)}%`}
              </Text>
            ) : undefined
          }
        />
      )}
      {highlightLayer}
      <View pointerEvents="none" style={[styles.badge, { bottom: insets.bottom + 6, backgroundColor: theme.bg }]}>
        <Text style={{ color: theme.muted, fontSize: 12 }} numberOfLines={1} maxFontSizeMultiplier={1.4}>
          {settings.showClock ? <ClockBattery color={theme.muted} /> : null}
          {settings.showClock ? ' · ' : ''}
          {pct.toFixed(1)}%{footerRight ? ` · ${footerRight}` : ''}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  end: { textAlign: 'center', paddingVertical: 32, fontSize: 13 },
  badge: { position: 'absolute', right: 12, paddingHorizontal: 6, borderRadius: 6, opacity: 0.9 },
});
