// Continuous scroll mode. The list holds a sliding window of a few chunks and
// grows or shrinks it at the edges as you scroll, so the list never holds the
// whole book.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View, type ViewToken, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Block, Position } from '@/engine/types';
import type { ReaderSettings, Theme } from '@/lib/settings';
import type { BookData } from './book';
import { BlockImage, BlockText, Spacer } from './BlockText';
import { lookOf } from './look';
import type { Mark } from './marks';

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
  onLongPressBlock?(b: number): void;
  footerRight?: string;
}

interface Win {
  first: number; // first chunk in the window
  last: number; // last chunk in the window
  start: number; // first block shown
}

export function ScrollReader({ book, settings, theme, start, startKey, version, onPosition, onTap, marksFor, onLongPressBlock, footerRight }: Props) {
  const win = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const width = win.width - settings.margin * 2;
  const blocks = useRef(new Map<number, Block[]>()).current;
  const [w, setW] = useState<Win | null>(null);
  const busy = useRef(false);
  const [pos, setPos] = useState<Position>(start);

  // Open at `start` (and again on every jump).
  useEffect(() => {
    let alive = true;
    blocks.clear();
    setW(null);
    const c = book.chunkOf(start.b);
    book.loadChunk(c).then((bl) => {
      if (!alive) return;
      blocks.set(c, bl);
      setW({ first: c, last: c, start: start.b });
    });
    return () => {
      alive = false;
    };
  }, [startKey]); // eslint-disable-line react-hooks/exhaustive-deps

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
    book.loadChunk(c).then((bl) => {
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
    book.loadChunk(c).then((bl) => {
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

  const renderItem = ({ item: b }: { item: number }) => {
    const c = book.chunkOf(b);
    const blk = blocks.get(c)?.[b - book.chunkStart(c)];
    if (!blk) return null;
    let content;
    if (blk.k === 'img') content = <BlockImage book={book} imageKey={blk.s!} width={width} />;
    else if (blk.k === 'sp' || blk.k === 'hr') content = <Spacer block={blk} settings={settings} theme={theme} />;
    else content = <BlockText block={blk} look={lookOf(blk, settings)} theme={theme} marks={marksFor?.(b)} />;
    return (
      <Pressable onLongPress={() => onLongPressBlock?.(b)} delayLongPress={450} style={{ paddingHorizontal: settings.margin }}>
        {content}
      </Pressable>
    );
  };

  const atEnd = w ? w.last >= book.chunkCount - 1 : false;
  const pct = book.fraction(pos) * 100;

  return (
    <View
      style={[styles.root, { backgroundColor: theme.bg }]}
      onTouchStart={(e) => (touch.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, t: Date.now() })}
      onTouchEnd={(e) => {
        const t = touch.current;
        if (Math.abs(e.nativeEvent.pageX - t.x) < 10 && Math.abs(e.nativeEvent.pageY - t.y) < 10 && Date.now() - t.t < 300) onTap();
      }}>
      {w && (
        <FlatList
          key={startKey}
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
      <View pointerEvents="none" style={[styles.badge, { bottom: insets.bottom + 6, backgroundColor: theme.bg }]}>
        <Text style={{ color: theme.muted, fontSize: 12 }}>
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
