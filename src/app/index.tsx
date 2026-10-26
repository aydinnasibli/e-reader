import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { Stack, router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlashList } from '@shopify/flash-list';
import { ActivityIndicator, Alert, BackHandler, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SearchBarCommands } from 'react-native-screens';
import { fold } from '@/engine/fold';
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
import { type BookEntry, importBooks, reprocessBook, updateBook, useLibrary, useLiveBook } from '@/lib/library';
import { useAddingSharedFile } from '@/lib/openWith';
import { Cover } from '@/ui/Cover';
import { confirmRemoveBook } from '@/ui/confirm';
import { showActions, showPrompt } from '@/ui/dialogs';
import { formatBytes } from '@/ui/format';
import { StatsSheet } from '@/ui/StatsSheet';
import { UpdateBanner } from '@/ui/UpdateBanner';
import { CURRENT_BUILD, canSelfUpdate, checkForUpdate } from '@/lib/appUpdate';
import { useCrashes } from '@/lib/crashLog';
import { backUp, restoreFromFile } from '@/ui/backupDialogs';
import { showCrashLog } from '@/ui/crashDialogs';
import { COLUMN_WIDTH, gridColumns } from '@/ui/layout';
import { type AppColors, useAppColors } from '@/ui/theme';
import { Tap } from '@/ui/Tap';

const GAP = 16;
/** Chips are drawn 34 high; the finger gets 44 (see styles.chips for the room above and below). */
const CHIP_SLOP = { top: 4, bottom: 6 };

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
  const [importing, setImporting] = useState(false);
  const addingShared = useAddingSharedFile();
  const [statsOpen, setStatsOpen] = useState(false);
  const crashes = useCrashes();
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

  // Case, accents and the Turkish I/ı/İ/i don't matter: "istanbul" finds
  // "İstanbul", "ilik" finds "ILIK". Folded once per change to the shelf.
  const q = fold(query.trim());
  const searchText = useMemo(() => new Map(books.map((b) => [b.id, fold(`${b.title}\n${b.author}`)])), [books]);
  const visible = useMemo(() => {
    const filtered = books.filter((b) => matches(b, filter) && (!q || !!searchText.get(b.id)?.includes(q)));
    return sortBooks(filtered, shelves.sort);
  }, [books, searchText, filter, q, shelves.sort]);

  // "Continue reading" card: the last book opened that isn't finished.
  const current = useMemo(
    () => (filter.kind === 'all' && !q ? sortBooks(books, 'recent').find((b) => (b.percent ?? 0) > 0 && !isFinished(b) && b.status !== 'error') : undefined),
    [books, filter, q],
  );

  const add = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const res = await importBooks();
      if (res.failed.length) Alert.alert("Couldn't add some books", `There may not be enough free space:\n\n${res.failed.join('\n')}`);
      // Picked from a cloud app or service that wouldn't let this app read them.
      if (res.unreadable.length) {
        Alert.alert(
          "Couldn't read some files",
          `The app or service they're in didn't let this app read them. Save them to the phone (Files or Downloads) and add them from there:\n\n${res.unreadable.join('\n')}`,
        );
      }
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
      { label: 'Back up highlights & notes', icon: 'share-outline', onPress: () => void backUp() },
      { label: 'Restore a backup…', icon: 'arrow-undo-outline', onPress: () => void restoreFromFile() },
      ...(crashes.length ? [{ label: `Crash log (${crashes.length})`, icon: 'bug-outline' as const, onPress: () => showCrashLog(crashes) }] : []),
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
        onPress: () => confirmRemoveBook(b),
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
        onPress: () =>
          Alert.alert('Delete collection?', `"${name}" will be deleted. The books in it stay in your library.`, [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete',
              style: 'destructive',
              onPress: () => {
                deleteCollection(id, books);
                if (filter.kind === 'collection' && filter.id === id) setFilter({ kind: 'all' });
              },
            },
          ]),
      },
    ]);

  const open = (b: BookEntry) => {
    if (b.status === 'error') {
      Alert.alert("Couldn't open this book", b.error ?? 'Unknown error', [
        { text: 'OK', style: 'cancel' },
        // The usual confirmation: it says what else goes (highlights, notes).
        { text: 'Remove', style: 'destructive', onPress: () => confirmRemoveBook(b) },
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
      <UpdateBanner style={{ maxWidth: topWidth }} />
      {addingShared ? (
        <View style={styles.adding}>
          <ActivityIndicator />
          <Text style={{ color: c.secondary, fontSize: 14 }}>Adding book…</Text>
        </View>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {chips.map((ch) => (
          <Tap
            key={ch.key}
            haptic="select"
            onPress={() => setFilter(ch.f)}
            onLongPress={ch.onLong}
            hitSlop={CHIP_SLOP}
            style={[styles.chip, { backgroundColor: active(ch.f) ? c.text : c.chip }]}>
            <Text style={{ color: active(ch.f) ? c.bg : c.text, fontSize: 14, fontWeight: '600' }}>{ch.label}</Text>
          </Tap>
        ))}
        <Tap onPress={() => newCollection()} hitSlop={CHIP_SLOP} style={[styles.chip, { backgroundColor: c.chip }]} accessibilityLabel="New collection">
          <Ionicons name="add" size={18} color={c.text} />
        </Tap>
      </ScrollView>
      {current ? <ContinueCard book={current} c={c} width={topWidth} onPress={() => open(current)} /> : null}
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
          // Each button is a 44-point square: a finger-sized target that the
          // header doesn't cut down (it ignores taps outside its buttons' boxes).
          headerRight: () => (
            <View style={styles.headerButtons}>
              <Tap onPress={() => router.push('/notes')} style={styles.headerButton} accessibilityLabel="Highlights and notes">
                <Ionicons name="color-wand-outline" size={22} color={c.text} />
              </Tap>
              <Tap onPress={() => setStatsOpen(true)} style={styles.headerButton} accessibilityLabel="Reading stats">
                <Ionicons name="stats-chart-outline" size={22} color={c.text} />
              </Tap>
              <Tap onPress={viewMenu} style={styles.headerButton} accessibilityLabel="View options">
                <Ionicons name="options-outline" size={24} color={c.text} />
              </Tap>
              {importing ? (
                <View style={styles.headerButton}>
                  <ActivityIndicator />
                </View>
              ) : (
                <Tap onPress={add} style={styles.headerButton} accessibilityLabel="Add books">
                  <Ionicons name="add" size={28} color={c.accent} />
                </Tap>
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
          contentContainerStyle={{ paddingBottom: insets.bottom + 40, paddingHorizontal: GAP / 2 }}
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
          contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
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

function ContinueCard({ book, c, width, onPress }: { book: BookEntry; c: AppColors; width: number; onPress(): void }) {
  const pct = book.percent ?? 0;
  return (
    <Tap feedback="card" onPress={onPress} style={[styles.continue, { backgroundColor: c.card, maxWidth: width }]} accessibilityLabel={`Continue reading: ${book.title}`}>
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
    </Tap>
  );
}

function GridCell({ book, width, c, onPress, onLongPress }: { book: BookEntry; width: number; c: AppColors; onPress(): void; onLongPress(): void }) {
  const status = useStatusText(book);
  const pct = book.percent ?? 0;
  const finished = isFinished(book);
  return (
    <Tap feedback="card" onPress={onPress} onLongPress={onLongPress} delayLongPress={350} style={{ width, margin: GAP / 2 }}>
      <View>
        <View>
          <Cover book={book} width={width} />
          {status ? (
            <View style={[styles.badge, book.status === 'error' && { backgroundColor: c.danger }]}>
              <Text style={[styles.badgeText, book.status === 'error' && { color: c.dangerText }]}>{status}</Text>
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
    </Tap>
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
  headerButtons: { flexDirection: 'row', alignItems: 'center' },
  headerButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  adding: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: GAP, paddingBottom: 10 },
  // Room above and below the chips for their larger touch area (CHIP_SLOP):
  // a touch outside the row would never reach them.
  chips: { paddingHorizontal: GAP, paddingTop: 4, paddingBottom: 12, gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 6, minHeight: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
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
  cellMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 16 },
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
