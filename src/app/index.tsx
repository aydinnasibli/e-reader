import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { Stack, router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlashList } from '@shopify/flash-list';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import {
  type Filter,
  SORT_LABELS,
  type SortKey,
  createCollection,
  deleteCollection,
  isFinished,
  matches,
  renameCollection,
  setSort,
  setView,
  sortBooks,
  toggleInCollection,
  useShelves,
} from '@/lib/collections';
import { type BookEntry, deleteBook, importBooks, reprocessBook, updateBook, useLibrary, useLiveBook } from '@/lib/library';
import { Cover } from '@/ui/Cover';
import { showActions, showPrompt } from '@/ui/dialogs';
import { formatBytes } from '@/ui/format';
import { StatsSheet } from '@/ui/StatsSheet';
import { UpdateBanner } from '@/ui/UpdateBanner';
import { CURRENT_BUILD, canSelfUpdate, checkForUpdate } from '@/lib/appUpdate';
import { type AppColors, useAppColors } from '@/ui/theme';

const GAP = 16;

export default function Library() {
  const c = useAppColors();
  const books = useLibrary();
  const shelves = useShelves();
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>({ kind: 'all' });
  const [importing, setImporting] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const columns = width >= 700 ? 5 : 3;
  const cellWidth = (width - GAP * (columns + 1)) / columns;

  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const filtered = books.filter(
      (b) => matches(b, filter) && (!q || b.title.toLocaleLowerCase().includes(q) || b.author.toLocaleLowerCase().includes(q)),
    );
    return sortBooks(filtered, shelves.sort);
  }, [books, filter, query, shelves.sort]);

  // "Continue reading" card: the last book opened that isn't finished.
  const current = useMemo(
    () => (filter.kind === 'all' && !query ? sortBooks(books, 'recent').find((b) => (b.percent ?? 0) > 0 && !isFinished(b) && b.status !== 'error') : undefined),
    [books, filter, query],
  );

  const add = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const res = await importBooks();
      if (res.failed.length) Alert.alert("Couldn't add some books", `There may not be enough free space:\n\n${res.failed.join('\n')}`);
      if (res.skipped.length) Alert.alert('Some files were skipped', `Supported formats: EPUB, FB2, MOBI, AZW3 and TXT:\n\n${res.skipped.join('\n')}`);
      if (res.duplicates.length) {
        const list = res.duplicates.map(([file, title]) => (file === title || !title ? file : `${file} — “${title}”`)).join('\n');
        Alert.alert('Already in your library', `Not added again:\n\n${list}`);
      }
    } catch (e) {
      Alert.alert('Import failed', e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const viewMenu = () =>
    showActions('View', [
      { label: 'Grid', icon: 'grid-outline', checked: shelves.view === 'grid', onPress: () => setView('grid') },
      { label: 'List', icon: 'list-outline', checked: shelves.view === 'list', onPress: () => setView('list') },
      ...(Object.keys(SORT_LABELS) as SortKey[]).map((k) => ({
        label: `Sort by ${SORT_LABELS[k].toLowerCase()}`,
        icon: 'swap-vertical-outline' as const,
        checked: shelves.sort === k,
        onPress: () => setSort(k),
      })),
      ...(canSelfUpdate()
        ? [
            {
              label: `Check for updates (you have 1.0.${CURRENT_BUILD})`,
              icon: 'cloud-download-outline' as const,
              onPress: async () => {
                const r = await checkForUpdate(true);
                // A newer build shows the update bar; failures show there too.
                if (r === 'none') Alert.alert('Up to date', `You have the latest version (1.0.${CURRENT_BUILD}).`);
              },
            },
          ]
        : []),
    ]);

  const newCollection = (then?: (id: string) => void) =>
    showPrompt('New collection', { placeholder: 'Name', confirm: 'Create', onSubmit: (name) => then?.(createCollection(name).id) });

  const bookMenu = (b: BookEntry) => {
    Haptics.selectionAsync().catch(() => {});
    const finished = isFinished(b);
    showActions(b.title, [
      { label: 'Details', icon: 'information-circle-outline', onPress: () => router.push({ pathname: '/book/[id]', params: { id: b.id } }) },
      { label: 'Add to collection…', icon: 'albums-outline', onPress: () => collectionsMenu(b) },
      {
        label: finished ? 'Mark as unread' : 'Mark as finished',
        icon: finished ? 'book-outline' : 'checkmark-done-outline',
        onPress: () => updateBook(b.id, { finished: !finished }),
      },
      {
        label: 'Remove from library',
        icon: 'trash-outline',
        destructive: true,
        onPress: () =>
          Alert.alert('Remove book?', `"${b.title}" will be deleted from this phone.`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Remove', style: 'destructive', onPress: () => deleteBook(b.id) },
          ]),
      },
    ]);
  };

  const collectionsMenu = (b: BookEntry) =>
    showActions('Collections', [
      ...shelves.collections.map((col) => ({
        label: col.name,
        icon: 'albums-outline' as const,
        checked: b.collections?.includes(col.id),
        onPress: () => toggleInCollection(b.id, col.id),
      })),
      { label: 'New collection…', icon: 'add', onPress: () => newCollection((id) => toggleInCollection(b.id, id)) },
    ]);

  const collectionMenu = (id: string, name: string) =>
    showActions(name, [
      { label: 'Rename', icon: 'pencil-outline', onPress: () => showPrompt('Rename collection', { initial: name, onSubmit: (n) => renameCollection(id, n) }) },
      {
        label: 'Delete collection',
        icon: 'trash-outline',
        destructive: true,
        onPress: () => {
          deleteCollection(id, books);
          if (filter.kind === 'collection' && filter.id === id) setFilter({ kind: 'all' });
        },
      },
    ]);

  const open = (b: BookEntry) => {
    if (b.status === 'error') {
      Alert.alert("Couldn't open this book", b.error ?? 'Unknown error', [
        { text: 'OK', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => deleteBook(b.id) },
        { text: 'Try again', onPress: () => reprocessBook(b.id) },
      ]);
      return;
    }
    router.push({ pathname: '/reader/[id]', params: { id: b.id } });
  };

  const chips: { key: string; label: string; f: Filter; onLong?: () => void }[] = [
    { key: 'all', label: 'All', f: { kind: 'all' } },
    { key: 'reading', label: 'Reading', f: { kind: 'reading' } },
    { key: 'finished', label: 'Finished', f: { kind: 'finished' } },
    ...shelves.collections.map((col) => ({
      key: col.id,
      label: col.name,
      f: { kind: 'collection', id: col.id } as Filter,
      onLong: () => collectionMenu(col.id, col.name),
    })),
  ];
  const active = (f: Filter) => f.kind === filter.kind && (f.kind !== 'collection' || (filter.kind === 'collection' && f.id === filter.id));

  const header = (
    // The grid's content is inset by half a gap; undo that for the full-width header.
    <View style={{ marginHorizontal: shelves.view === 'grid' ? -GAP / 2 : 0 }}>
      <UpdateBanner />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {chips.map((ch) => (
          <Pressable
            key={ch.key}
            onPress={() => setFilter(ch.f)}
            onLongPress={ch.onLong}
            style={[styles.chip, { backgroundColor: active(ch.f) ? c.text : c.chip }]}>
            <Text style={{ color: active(ch.f) ? c.bg : c.text, fontSize: 14, fontWeight: '600' }}>{ch.label}</Text>
          </Pressable>
        ))}
        <Pressable onPress={() => newCollection()} style={[styles.chip, { backgroundColor: c.chip }]} accessibilityLabel="New collection">
          <Ionicons name="add" size={18} color={c.text} />
        </Pressable>
      </ScrollView>
      {current ? <ContinueCard book={current} c={c} onPress={() => open(current)} /> : null}
      {current && visible.length ? <Text style={[styles.section, { color: c.text }]}>All books</Text> : null}
    </View>
  );

  const empty = (
    <View style={styles.empty}>
      <Ionicons name={books.length ? 'search-outline' : 'library-outline'} size={56} color={c.secondary} />
      <Text style={[styles.emptyTitle, { color: c.text }]}>{books.length ? 'Nothing here' : 'Your library is empty'}</Text>
      <Text style={[styles.emptyText, { color: c.secondary }]}>
        {books.length ? 'No books match this filter or search.' : 'Add EPUB, FB2, MOBI, AZW3 or TXT books from Files. Huge ones are fine.'}
      </Text>
      {!books.length && (
        <Pressable onPress={add} style={[styles.emptyBtn, { backgroundColor: c.accent }]}>
          <Text style={{ color: c.accentText, fontSize: 16, fontWeight: '600' }}>Add books</Text>
        </Pressable>
      )}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
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
            placeholder: 'Search title or author',
            hideWhenScrolling: true,
            onChangeText: (e) => setQuery(e.nativeEvent.text),
            onCancelButtonPress: () => setQuery(''),
          },
          headerRight: () => (
            <View style={styles.headerButtons}>
              <Pressable onPress={() => router.push('/notes')} hitSlop={10} accessibilityLabel="Highlights and notes">
                <Ionicons name="color-wand-outline" size={22} color={c.text} />
              </Pressable>
              <Pressable onPress={() => setStatsOpen(true)} hitSlop={10} accessibilityLabel="Reading stats">
                <Ionicons name="stats-chart-outline" size={22} color={c.text} />
              </Pressable>
              <Pressable onPress={viewMenu} hitSlop={10} accessibilityLabel="View options">
                <Ionicons name="options-outline" size={24} color={c.text} />
              </Pressable>
              {importing ? (
                <ActivityIndicator />
              ) : (
                <Pressable onPress={add} hitSlop={10} accessibilityLabel="Add books">
                  <Ionicons name="add" size={28} color={c.accent} />
                </Pressable>
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
          keyExtractor={(b) => b.id}
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          contentContainerStyle={{ paddingBottom: 40, paddingHorizontal: GAP / 2 }}
          renderItem={({ item }) => <GridCell book={item} width={cellWidth} c={c} onPress={() => open(item)} onLongPress={() => bookMenu(item)} />}
        />
      ) : (
        <FlashList
          key="list"
          data={visible}
          keyExtractor={(b) => b.id}
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          contentContainerStyle={{ paddingBottom: 40 }}
          ItemSeparatorComponent={() => <View style={[styles.sep, { backgroundColor: c.border }]} />}
          renderItem={({ item }) => <ListRow book={item} c={c} onPress={() => open(item)} onLongPress={() => bookMenu(item)} />}
        />
      )}
      <StatsSheet visible={statsOpen} onClose={() => setStatsOpen(false)} />
    </View>
  );
}

/** "Preparing 40%" while converting (live, so only this cell redraws), or the failure. */
function useStatusText(b: BookEntry): string | null {
  const live = useLiveBook(b.id);
  if (b.status === 'processing') return `Preparing ${Math.round((live?.progress ?? 0) * 100)}%`;
  if (b.status === 'error') return 'Failed to open';
  return null;
}

function Progress({ value, c }: { value: number; c: AppColors }) {
  return (
    <View style={[styles.track, { backgroundColor: c.border }]}>
      <View style={[styles.fill, { width: `${Math.round(value * 100)}%`, backgroundColor: c.accent }]} />
    </View>
  );
}

function ContinueCard({ book, c, onPress }: { book: BookEntry; c: AppColors; onPress(): void }) {
  const pct = book.percent ?? 0;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.continue, { backgroundColor: c.card, opacity: pressed ? 0.85 : 1 }]}>
      <Cover book={book} width={78} />
      <View style={styles.continueBody}>
        <Text style={[styles.kicker, { color: c.secondary }]}>CONTINUE READING</Text>
        <Text numberOfLines={2} style={[styles.continueTitle, { color: c.text }]}>
          {book.title}
        </Text>
        {book.author ? (
          <Text numberOfLines={1} style={{ color: c.secondary, fontSize: 14 }}>
            {book.author}
          </Text>
        ) : null}
        <View style={styles.continueProgress}>
          <View style={{ flex: 1 }}>
            <Progress value={pct} c={c} />
          </View>
          <Text style={{ color: c.secondary, fontSize: 13 }}>{Math.round(pct * 100)}%</Text>
        </View>
      </View>
    </Pressable>
  );
}

function GridCell({ book, width, c, onPress, onLongPress }: { book: BookEntry; width: number; c: AppColors; onPress(): void; onLongPress(): void }) {
  const status = useStatusText(book);
  const pct = book.percent ?? 0;
  const finished = isFinished(book);
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} delayLongPress={350} style={{ width, margin: GAP / 2 }}>
      {({ pressed }) => (
        <View style={{ opacity: pressed ? 0.8 : 1 }}>
          <View>
            <Cover book={book} width={width} />
            {status ? (
              <View style={[styles.badge, book.status === 'error' && { backgroundColor: c.danger }]}>
                <Text style={styles.badgeText}>{status}</Text>
              </View>
            ) : null}
          </View>
          <Text numberOfLines={2} style={[styles.cellTitle, { color: c.text }]}>
            {book.title}
          </Text>
          <View style={styles.cellMeta}>
            {finished ? (
              <Text style={{ color: c.secondary, fontSize: 12 }}>Finished</Text>
            ) : pct > 0 ? (
              <>
                <View style={{ flex: 1 }}>
                  <Progress value={pct} c={c} />
                </View>
                <Text style={{ color: c.secondary, fontSize: 11 }}>{Math.round(pct * 100)}%</Text>
              </>
            ) : (
              <Text style={{ color: c.accent, fontSize: 12, fontWeight: '600' }}>New</Text>
            )}
          </View>
        </View>
      )}
    </Pressable>
  );
}

function ListRow({ book, c, onPress, onLongPress }: { book: BookEntry; c: AppColors; onPress(): void; onLongPress(): void }) {
  const status = useStatusText(book);
  const pct = book.percent ?? 0;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? c.chip : 'transparent' }]}>
      <Cover book={book} width={50} radius={4} />
      <View style={styles.rowBody}>
        <Text numberOfLines={2} style={[styles.rowTitle, { color: c.text }]}>
          {book.title}
        </Text>
        {book.author ? (
          <Text numberOfLines={1} style={{ color: c.secondary, fontSize: 14 }}>
            {book.author}
          </Text>
        ) : null}
        <Text style={{ color: status && book.status === 'error' ? c.danger : c.secondary, fontSize: 12, marginTop: 4 }}>
          {status ?? (isFinished(book) ? 'Finished' : pct > 0 ? `${Math.round(pct * 100)}% read` : 'New')} · {book.format?.toUpperCase() ?? ''} {formatBytes(book.size)}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={c.secondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headerButtons: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  chips: { paddingHorizontal: GAP, paddingTop: 4, paddingBottom: 12, gap: 8 },
  chip: { paddingHorizontal: 14, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  continue: {
    flexDirection: 'row',
    marginHorizontal: GAP,
    marginBottom: 8,
    padding: 14,
    borderRadius: 16,
    gap: 16,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  continueBody: { flex: 1, justifyContent: 'center', gap: 3 },
  kicker: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  continueTitle: { fontSize: 18, fontWeight: '700' },
  continueProgress: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  section: { fontSize: 20, fontWeight: '700', marginHorizontal: GAP, marginTop: 18, marginBottom: 2 },
  badge: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.65)', paddingVertical: 4, alignItems: 'center' },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  cellTitle: { fontSize: 13, fontWeight: '600', marginTop: 8, minHeight: 34 },
  cellMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 16 },
  track: { height: 3, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 3 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: GAP, paddingVertical: 10, gap: 14 },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 16, fontWeight: '600' },
  sep: { height: StyleSheet.hairlineWidth, marginLeft: GAP + 64 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40, gap: 10, minHeight: 360 },
  emptyTitle: { fontSize: 20, fontWeight: '700', marginTop: 6 },
  emptyText: { fontSize: 15, textAlign: 'center' },
  emptyBtn: { marginTop: 12, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 12 },
});
