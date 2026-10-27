import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlashList, type ListRenderItem } from '@shopify/flash-list';
import { ActivityIndicator, BackHandler, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SearchBarCommands } from 'react-native-screens';
import { fold } from '@/engine/fold';
import { type Filter, isFinished, matches, sortBooks, useShelves } from '@/lib/collections';
import { type BookEntry, useLibrary } from '@/lib/library';
import { HeaderButton, headerButton } from '@/ui/HeaderButton';
import { COLUMN_WIDTH, gridColumns } from '@/ui/layout';
import { bookMenu, openBook, useAddBooks, useLibraryMenus } from '@/ui/library/actions';
import { GAP, GridCell, ListRow, ListSeparator } from '@/ui/library/cells';
import { LibraryHeader } from '@/ui/library/LibraryHeader';
import { pushOnce } from '@/ui/navigate';
import { StatsSheet } from '@/ui/StatsSheet';
import { useAppColors } from '@/ui/theme';
import { Tap } from '@/ui/Tap';

/**
 * A book's title and author, folded for searching (case, accents and the
 * Turkish I/ı/İ/i don't matter: "istanbul" finds "İstanbul", "ilik" finds
 * "ILIK"). Kept per book entry, which is replaced whenever the book changes:
 * the library changes on every page turn, and only that book is folded again.
 */
const folded = new WeakMap<BookEntry, string>();
function searchText(b: BookEntry): string {
  let s = folded.get(b);
  if (s === undefined) folded.set(b, (s = fold(`${b.title}\n${b.author}`)));
  return s;
}

const bookKey = (b: BookEntry) => b.id;

export default function Library() {
  const c = useAppColors();
  const books = useLibrary();
  const shelves = useShelves();
  const win = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // Clear of a landscape camera cutout on either side.
  const width = win.width - insets.left - insets.right;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>({ kind: 'all' });
  const [statsOpen, setStatsOpen] = useState(false);
  const { importing, add } = useAddBooks();
  const { viewMenu, collectionMenu } = useLibraryMenus(books, filter, setFilter);
  const columns = gridColumns(width);
  const cellWidth = (width - GAP * (columns + 1)) / columns;
  // The update bar and the "Continue reading" card span whole columns of the
  // grid, at most the shared column's width: the whole phone, part of a tablet.
  const span = Math.min(columns, Math.max(1, Math.floor((COLUMN_WIDTH + GAP) / (cellWidth + GAP))));
  const topWidth = span * cellWidth + (span - 1) * GAP;

  // The search field in the header. On Android it opens from its icon, and
  // Back closes it: otherwise the first Back only drops the keyboard and the
  // next one leaves the app.
  const search = useRef<SearchBarCommands>(null);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (!searching) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // A screen opened from the library is on top: Back is for it.
      if (router.canGoBack()) return false;
      search.current?.cancelSearch();
      setSearching(false);
      setQuery('');
      return true;
    });
    return () => sub.remove();
  }, [searching]);

  const q = fold(query.trim());
  const visible = useMemo(() => {
    const filtered = books.filter((b) => matches(b, filter) && (!q || searchText(b).includes(q)));
    return sortBooks(filtered, shelves.sort);
  }, [books, filter, q, shelves.sort]);

  // "Continue reading" card: the last book opened that isn't finished.
  const current = useMemo(
    () => (filter.kind === 'all' && !q ? sortBooks(books, 'recent').find((b) => (b.percent ?? 0) > 0 && !isFinished(b) && b.status !== 'error') : undefined),
    [books, filter, q],
  );

  // The same functions on every redraw, so a cell is drawn again only when its book changes.
  const renderCell = useCallback<ListRenderItem<BookEntry>>(
    ({ item }) => <GridCell book={item} width={cellWidth} c={c} onOpen={openBook} onMenu={bookMenu} />,
    [cellWidth, c],
  );
  const renderRow = useCallback<ListRenderItem<BookEntry>>(({ item }) => <ListRow book={item} c={c} onOpen={openBook} onMenu={bookMenu} />, [c]);

  const header = (
    <LibraryHeader
      c={c}
      grid={shelves.view === 'grid'}
      topWidth={topWidth}
      filter={filter}
      onFilter={setFilter}
      collections={shelves.collections}
      onCollectionMenu={collectionMenu}
      current={current}
      onOpen={openBook}
      section={!!current && visible.length > 0}
    />
  );

  const empty = (
    <View style={styles.empty}>
      <Ionicons name={books.length ? 'search-outline' : 'library-outline'} size={56} color={c.secondary} />
      <Text style={[styles.emptyTitle, { color: c.text }]}>{books.length ? 'Nothing here' : 'Your library is empty'}</Text>
      <Text style={[styles.emptyText, { color: c.secondary }]}>
        {books.length ? 'No books match this filter or search.' : 'Add EPUB, FB2, MOBI, AZW3 or TXT books from Files. Huge ones are fine.'}
      </Text>
      {!books.length && (
        <Tap onPress={add} style={[styles.emptyBtn, { backgroundColor: c.accent }]}>
          <Text style={{ color: c.accentText, fontSize: 16, fontWeight: '600' }}>Add books</Text>
        </Tap>
      )}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.bg, paddingLeft: insets.left, paddingRight: insets.right }}>
      <Stack.Screen
        options={{
          title: 'Library',
          headerLargeTitleEnabled: true,
          headerTransparent: false,
          headerShadowVisible: false,
          headerStyle: { backgroundColor: c.bg },
          headerLargeStyle: { backgroundColor: c.bg },
          headerTintColor: c.text,
          headerSearchBarOptions: {
            ref: search,
            placeholder: 'Search title or author',
            hideWhenScrolling: true,
            // Android draws the search icon and text black unless told, even on a dark header.
            headerIconColor: c.text,
            textColor: c.text,
            hintTextColor: c.secondary,
            tintColor: c.accent,
            onChangeText: (e) => setQuery(e.nativeEvent.text),
            onOpen: () => setSearching(true),
            onClose: () => {
              setSearching(false);
              setQuery('');
            },
            onCancelButtonPress: () => setQuery(''),
          },
          headerRight: () => (
            <View style={styles.headerButtons}>
              <HeaderButton icon="color-wand-outline" color={c.text} label="Highlights and notes" onPress={() => pushOnce('/notes')} />
              <HeaderButton icon="stats-chart-outline" color={c.text} label="Reading stats" onPress={() => setStatsOpen(true)} />
              <HeaderButton icon="options-outline" size={24} color={c.text} label="View options" onPress={viewMenu} />
              {importing ? (
                <View style={headerButton.box}>
                  <ActivityIndicator />
                </View>
              ) : (
                <HeaderButton icon="add" size={28} color={c.accent} label="Add books" onPress={add} />
              )}
            </View>
          ),
        }}
      />
      {shelves.view === 'grid' ? (
        <FlashList
          key={`grid${columns}`}
          data={visible}
          numColumns={columns}
          keyExtractor={bookKey}
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          contentContainerStyle={{ paddingBottom: insets.bottom + 40, paddingHorizontal: GAP / 2 }}
          renderItem={renderCell}
        />
      ) : (
        <FlashList
          key="list"
          data={visible}
          keyExtractor={bookKey}
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
          ItemSeparatorComponent={ListSeparator}
          renderItem={renderRow}
        />
      )}
      <StatsSheet visible={statsOpen} onClose={() => setStatsOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  headerButtons: { flexDirection: 'row', alignItems: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40, gap: 10, minHeight: 360 },
  emptyTitle: { fontSize: 20, fontWeight: '700', marginTop: 6 },
  emptyText: { fontSize: 15, textAlign: 'center' },
  emptyBtn: { marginTop: 12, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 12 },
});
