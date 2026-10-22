// Reader sheets: navigator (contents, bookmarks, highlights), search, settings.

import Ionicons from '@expo/vector-icons/Ionicons';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { Position, TocEntry } from '@/engine/types';
import { type Bookmark, type Highlight, removeBookmark, removeHighlight, useAnnotations } from '@/lib/annotations';
import {
  FONT_SIZES,
  LINE_SPACINGS,
  MARGINS,
  type ReaderSettings,
  THEMES,
  type Theme,
  type ThemeName,
  setSettings,
} from '@/lib/settings';
import { Sheet } from '@/ui/Sheet';
import type { BookData } from './book';
import { type Hit, MAX_HITS, type SearchProgress, searchBook } from './search';
import { highlightColor } from './SelectionSheet';

const sheetColors = (t: Theme) => ({ bg: t.chrome, text: t.text, border: t.border });

// ---------- navigator ----------

type Tab = 'contents' | 'bookmarks' | 'highlights';

export function NavigatorSheet({
  visible,
  onClose,
  theme,
  book,
  currentBlock,
  onGo,
}: {
  visible: boolean;
  onClose(): void;
  theme: Theme;
  book: BookData;
  currentBlock: number;
  onGo(pos: Position, mark?: { s: number; e: number }): void;
}) {
  const [tab, setTab] = useState<Tab>('contents');
  const ann = useAnnotations(book.entry.id);
  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'contents', label: 'Contents' },
    { key: 'bookmarks', label: 'Bookmarks', count: ann.bookmarks.length },
    { key: 'highlights', label: 'Highlights', count: ann.highlights.length },
  ];
  return (
    <Sheet visible={visible} onClose={onClose} colors={sheetColors(theme)} height={0.8}>
      <View style={[styles.tabs, { backgroundColor: theme.bg }]}>
        {tabs.map((t) => (
          <Pressable key={t.key} onPress={() => setTab(t.key)} style={[styles.tab, tab === t.key && { backgroundColor: theme.chrome }]}>
            <Text style={{ color: theme.text, fontWeight: tab === t.key ? '700' : '500', fontSize: 14 }}>
              {t.label}
              {t.count ? ` ${t.count}` : ''}
            </Text>
          </Pressable>
        ))}
      </View>
      {tab === 'contents' && <TocList book={book} theme={theme} currentBlock={currentBlock} visible={visible} onGo={onGo} />}
      {tab === 'bookmarks' && (
        <AnnotationList
          items={ann.bookmarks}
          theme={theme}
          empty="No bookmarks yet. Open the menu and tap the bookmark icon to save a page."
          render={(bm: Bookmark) => (
            <>
              <Ionicons name="bookmark" size={18} color={theme.accent} style={styles.leadIcon} />
              <View style={{ flex: 1 }}>
                <Text numberOfLines={2} style={{ color: theme.text, fontSize: 15 }}>
                  {bm.snippet || '…'}
                </Text>
                <Text numberOfLines={1} style={[styles.meta, { color: theme.muted }]}>
                  {[bm.chapter, new Date(bm.createdAt).toLocaleDateString()].filter(Boolean).join(' · ')}
                </Text>
              </View>
            </>
          )}
          onPress={(bm) => onGo({ b: bm.b, o: bm.o })}
          onDelete={(bm) => removeBookmark(book.entry.id, bm.id)}
        />
      )}
      {tab === 'highlights' && (
        <AnnotationList
          items={ann.highlights}
          theme={theme}
          empty="No highlights yet. Long-press a paragraph to highlight text or add a note."
          render={(h: Highlight) => (
            <>
              <View style={[styles.colorBar, { backgroundColor: highlightColor(h.color, theme.dark) }]} />
              <View style={{ flex: 1 }}>
                <Text numberOfLines={3} style={{ color: theme.text, fontSize: 15 }}>
                  {h.text}
                </Text>
                {h.note ? (
                  <Text numberOfLines={3} style={{ color: theme.text, fontSize: 14, fontStyle: 'italic', marginTop: 4, opacity: 0.8 }}>
                    {h.note}
                  </Text>
                ) : null}
                {h.chapter ? (
                  <Text numberOfLines={1} style={[styles.meta, { color: theme.muted }]}>
                    {h.chapter}
                  </Text>
                ) : null}
              </View>
            </>
          )}
          onPress={(h) => onGo({ b: h.b, o: h.s })}
          onDelete={(h) => removeHighlight(book.entry.id, h.id)}
        />
      )}
    </Sheet>
  );
}

function TocList({ book, theme, currentBlock, visible, onGo }: { book: BookData; theme: Theme; currentBlock: number; visible: boolean; onGo(pos: Position): void }) {
  const toc = book.toc;
  let current = -1;
  for (let i = 0; i < toc.length && toc[i].b <= currentBlock; i++) current = i;
  const list = useRef<FlatList<TocEntry>>(null);
  useEffect(() => {
    if (visible && current > 3) {
      const t = setTimeout(() => list.current?.scrollToIndex({ index: current, viewPosition: 0.3, animated: false }), 60);
      return () => clearTimeout(t);
    }
  }, [visible, current]);
  if (!toc.length) {
    return (
      <Text style={[styles.empty, { color: theme.muted }]}>
        {book.complete ? 'This book has no table of contents.' : 'The contents will appear when the book has finished preparing.'}
      </Text>
    );
  }
  return (
    <FlatList
      ref={list}
      data={toc}
      keyExtractor={(_, i) => String(i)}
      getItemLayout={(_, i) => ({ length: 50, offset: 50 * i, index: i })}
      onScrollToIndexFailed={() => {}}
      renderItem={({ item, index }) => (
        <Pressable onPress={() => onGo({ b: item.b, o: 0 })} style={[styles.tocRow, { paddingLeft: 20 + Math.min(item.l, 4) * 18 }]}>
          <Text
            numberOfLines={1}
            style={{ flex: 1, color: index === current ? theme.accent : theme.text, fontSize: 16, fontWeight: index === current ? '700' : '400' }}>
            {item.t}
          </Text>
          <Text style={{ color: theme.muted, fontSize: 13 }}>{book.totalChars ? `${Math.round((book.chunks[book.chunkOf(item.b)]?.[1] / book.estimatedChars) * 100)}%` : ''}</Text>
        </Pressable>
      )}
    />
  );
}

function AnnotationList<T extends { id: string }>({
  items,
  theme,
  empty,
  render,
  onPress,
  onDelete,
}: {
  items: T[];
  theme: Theme;
  empty: string;
  render(item: T): ReactNode;
  onPress(item: T): void;
  onDelete(item: T): void;
}) {
  if (!items.length) return <Text style={[styles.empty, { color: theme.muted }]}>{empty}</Text>;
  return (
    <FlatList
      data={items}
      keyExtractor={(x) => x.id}
      ItemSeparatorComponent={() => <View style={[styles.sep, { backgroundColor: theme.border }]} />}
      renderItem={({ item }) => (
        <Pressable onPress={() => onPress(item)} style={({ pressed }) => [styles.annRow, pressed && { opacity: 0.6 }]}>
          {render(item)}
          <Pressable onPress={() => onDelete(item)} hitSlop={10} accessibilityLabel="Delete">
            <Ionicons name="trash-outline" size={19} color={theme.muted} />
          </Pressable>
        </Pressable>
      )}
    />
  );
}

// ---------- search ----------

export function SearchSheet({
  visible,
  onClose,
  theme,
  book,
  onGo,
}: {
  visible: boolean;
  onClose(): void;
  theme: Theme;
  book: BookData;
  onGo(pos: Position, mark: { s: number; e: number }): void;
}) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchProgress | null>(null);
  const cancel = useRef<(() => void) | null>(null);

  const run = (q: string) => {
    cancel.current?.();
    setResult(null);
    if (q.trim().length < 2) return;
    setResult({ hits: [], done: 0, finished: false });
    cancel.current = searchBook(book, q, setResult);
  };
  useEffect(() => () => cancel.current?.(), []);

  const hits = result?.hits ?? [];
  return (
    <Sheet visible={visible} onClose={onClose} colors={sheetColors(theme)} height={0.85}>
      <View style={[styles.searchBox, { backgroundColor: theme.bg, borderColor: theme.border }]}>
        <Ionicons name="search" size={18} color={theme.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={() => run(query)}
          placeholder="Search in book"
          placeholderTextColor={theme.muted}
          returnKeyType="search"
          autoFocus
          autoCorrect={false}
          style={[styles.searchInput, { color: theme.text }]}
        />
        {query ? (
          <Pressable
            onPress={() => {
              setQuery('');
              cancel.current?.();
              setResult(null);
            }}
            hitSlop={10}>
            <Ionicons name="close-circle" size={18} color={theme.muted} />
          </Pressable>
        ) : null}
      </View>
      {result && (
        <View style={styles.searchStatus}>
          {!result.finished && <ActivityIndicator size="small" color={theme.muted} />}
          <Text style={{ color: theme.muted, fontSize: 13 }}>
            {result.finished
              ? hits.length >= MAX_HITS
                ? `First ${MAX_HITS} results`
                : `${hits.length} result${hits.length === 1 ? '' : 's'}`
              : `${hits.length} so far · searched ${Math.round(result.done * 100)}%`}
          </Text>
        </View>
      )}
      <FlatList
        data={hits}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(h, i) => `${h.b}:${h.o}:${i}`}
        ItemSeparatorComponent={() => <View style={[styles.sep, { backgroundColor: theme.border }]} />}
        renderItem={({ item }: { item: Hit }) => (
          <Pressable onPress={() => onGo({ b: item.b, o: item.o }, { s: item.o, e: item.o + item.len })} style={styles.hit}>
            <Text numberOfLines={3} style={{ color: theme.text, fontSize: 15, lineHeight: 21 }}>
              {item.before}
              <Text style={{ backgroundColor: theme.accent + '44', fontWeight: '700' }}>{item.match}</Text>
              {item.after}
            </Text>
            <Text style={[styles.meta, { color: theme.muted }]}>{book.chapterAt(item.b)?.t ?? ''}</Text>
          </Pressable>
        )}
      />
    </Sheet>
  );
}

// ---------- settings ----------

function Row({ label, theme, children }: { label: string; theme: Theme; children: ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
      <View style={styles.rowRight}>{children}</View>
    </View>
  );
}

function Choice<T>({ options, value, onPick, theme, render }: { options: T[]; value: T; onPick(v: T): void; theme: Theme; render(v: T): string }) {
  return (
    <View style={[styles.segment, { backgroundColor: theme.bg }]}>
      {options.map((o, i) => (
        <Pressable key={i} onPress={() => onPick(o)} style={[styles.segItem, o === value && { backgroundColor: theme.accent }]}>
          <Text style={{ color: o === value ? '#fff' : theme.text, fontSize: 14, fontWeight: '500' }}>{render(o)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function SettingsSheet({ visible, onClose, theme, settings }: { visible: boolean; onClose(): void; theme: Theme; settings: ReaderSettings }) {
  const sizeIndex = FONT_SIZES.indexOf(settings.fontSize);
  const step = (d: number) => {
    const i = Math.max(0, Math.min(FONT_SIZES.length - 1, (sizeIndex < 0 ? 5 : sizeIndex) + d));
    setSettings({ fontSize: FONT_SIZES[i] });
  };
  return (
    <Sheet visible={visible} onClose={onClose} colors={sheetColors(theme)}>
      <ScrollView>
        <View style={styles.sizeRow}>
          <Pressable onPress={() => step(-1)} style={[styles.sizeBtn, { backgroundColor: theme.bg }]} accessibilityLabel="Smaller text">
            <Text style={{ color: theme.text, fontSize: 15 }}>A</Text>
          </Pressable>
          <Text style={{ color: theme.muted, width: 40, textAlign: 'center' }}>{settings.fontSize}</Text>
          <Pressable onPress={() => step(1)} style={[styles.sizeBtn, { backgroundColor: theme.bg }]} accessibilityLabel="Larger text">
            <Text style={{ color: theme.text, fontSize: 24 }}>A</Text>
          </Pressable>
        </View>
        <View style={styles.themes}>
          {(Object.keys(THEMES) as ThemeName[]).map((name) => (
            <Pressable
              key={name}
              onPress={() => setSettings({ theme: name })}
              style={[styles.swatch, { backgroundColor: THEMES[name].bg, borderColor: settings.theme === name ? theme.accent : theme.border }]}>
              <Text style={{ color: THEMES[name].text, fontSize: 15, fontWeight: '600' }}>Aa</Text>
              <Text style={{ color: THEMES[name].muted, fontSize: 11, marginTop: 2, textTransform: 'capitalize' }}>{name}</Text>
            </Pressable>
          ))}
        </View>
        <Row label="Mode" theme={theme}>
          <Choice
            options={['page', 'scroll'] as ReaderSettings['mode'][]}
            value={settings.mode}
            onPick={(mode) => setSettings({ mode })}
            theme={theme}
            render={(m) => (m === 'page' ? 'Pages' : 'Scroll')}
          />
        </Row>
        <Row label="Font" theme={theme}>
          <Choice
            options={['serif', 'sans'] as ReaderSettings['font'][]}
            value={settings.font}
            onPick={(font) => setSettings({ font })}
            theme={theme}
            render={(f) => (f === 'serif' ? 'Serif' : 'Sans')}
          />
        </Row>
        <Row label="Line spacing" theme={theme}>
          <Choice
            options={LINE_SPACINGS}
            value={settings.lineSpacing}
            onPick={(lineSpacing) => setSettings({ lineSpacing })}
            theme={theme}
            render={(v) => (v === LINE_SPACINGS[0] ? 'Tight' : v === LINE_SPACINGS[1] ? 'Normal' : 'Loose')}
          />
        </Row>
        <Row label="Margins" theme={theme}>
          <Choice
            options={MARGINS}
            value={settings.margin}
            onPick={(margin) => setSettings({ margin })}
            theme={theme}
            render={(v) => (v === MARGINS[0] ? 'Narrow' : v === MARGINS[1] ? 'Normal' : 'Wide')}
          />
        </Row>
        <Row label="Justify text" theme={theme}>
          <Switch value={settings.justify} onValueChange={(justify) => setSettings({ justify })} />
        </Row>
        <Row label="Indent paragraphs" theme={theme}>
          <Switch value={settings.indent} onValueChange={(indent) => setSettings({ indent })} />
        </Row>
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 8, borderRadius: 10, padding: 3 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 8 },
  empty: { paddingHorizontal: 24, paddingVertical: 28, fontSize: 15, lineHeight: 22, textAlign: 'center' },
  tocRow: { height: 50, flexDirection: 'row', alignItems: 'center', paddingRight: 20, gap: 12 },
  annRow: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 20, paddingVertical: 14, gap: 12 },
  leadIcon: { marginTop: 2 },
  colorBar: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  meta: { fontSize: 12, marginTop: 4 },
  sep: { height: StyleSheet.hairlineWidth, marginLeft: 20 },
  searchBox: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, paddingHorizontal: 12, borderRadius: 12, gap: 8, height: 44 },
  searchInput: { flex: 1, fontSize: 16, height: 44 },
  searchStatus: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 10 },
  hit: { paddingHorizontal: 20, paddingVertical: 12 },
  sizeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 10 },
  sizeBtn: { width: 96, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  themes: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 10 },
  swatch: { width: 72, height: 60, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 8, minHeight: 50 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { fontSize: 16 },
  segment: { flexDirection: 'row', borderRadius: 9, padding: 2 },
  segItem: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 7 },
});
