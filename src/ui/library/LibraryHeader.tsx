// Above the library's books: the update bar, "Adding book…", the filter chips
// (All, Reading, Finished, then the collections) and the "Continue reading"
// card.

import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Collection, Filter } from '@/lib/collections';
import type { BookEntry } from '@/lib/library';
import { useAddingSharedFile } from '@/lib/openWith';
import { Tap } from '@/ui/Tap';
import type { AppColors } from '@/ui/theme';
import { UpdateBanner } from '@/ui/UpdateBanner';
import { newCollection } from './actions';
import { ContinueCard, GAP } from './cells';

/** Chips are drawn 34 high; the finger gets 44 (see styles.chips for the room above and below). */
const CHIP_SLOP = { top: 4, bottom: 6 };

interface Props {
  c: AppColors;
  /** The grid's content is inset by half a gap; the header undoes that. */
  grid: boolean;
  /** How wide the update bar and the "Continue reading" card may be. */
  topWidth: number;
  filter: Filter;
  onFilter(f: Filter): void;
  collections: readonly Collection[];
  onCollectionMenu(id: string, name: string): void;
  /** The last book opened that isn't finished, if it's shown. */
  current?: BookEntry;
  onOpen(b: BookEntry): void;
  /** "All books" under the card: it and books below it are both shown. */
  section: boolean;
}

export function LibraryHeader({ c, grid, topWidth, filter, onFilter, collections, onCollectionMenu, current, onOpen, section }: Props) {
  const addingShared = useAddingSharedFile();
  const chips: { key: string; label: string; f: Filter; onLong?: () => void }[] = [
    { key: 'all', label: 'All', f: { kind: 'all' } },
    { key: 'reading', label: 'Reading', f: { kind: 'reading' } },
    { key: 'finished', label: 'Finished', f: { kind: 'finished' } },
    ...collections.map((col) => ({
      key: col.id,
      label: col.name,
      f: { kind: 'collection', id: col.id } as Filter,
      onLong: () => onCollectionMenu(col.id, col.name),
    })),
  ];
  const active = (f: Filter) => f.kind === filter.kind && (f.kind !== 'collection' || (filter.kind === 'collection' && f.id === filter.id));

  return (
    <View style={{ marginHorizontal: grid ? -GAP / 2 : 0 }}>
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
            onPress={() => onFilter(ch.f)}
            onLongPress={ch.onLong}
            hitSlop={CHIP_SLOP}
            // The chosen filter is told apart by its colour; a screen reader says it.
            accessibilityState={{ selected: active(ch.f) }}
            style={[styles.chip, { backgroundColor: active(ch.f) ? c.text : c.chip }]}>
            <Text style={{ color: active(ch.f) ? c.bg : c.text, fontSize: 14, fontWeight: '600' }}>{ch.label}</Text>
          </Tap>
        ))}
        <Tap onPress={() => newCollection()} hitSlop={CHIP_SLOP} style={[styles.chip, { backgroundColor: c.chip }]} accessibilityLabel="New collection">
          <Ionicons name="add" size={18} color={c.text} />
        </Tap>
      </ScrollView>
      {current ? <ContinueCard book={current} c={c} width={topWidth} onOpen={onOpen} /> : null}
      {section ? <Text style={[styles.section, { color: c.text }]}>All books</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  adding: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: GAP, paddingBottom: 10 },
  // Room above and below the chips for their larger touch area (CHIP_SLOP):
  // a touch outside the row would never reach them.
  chips: { paddingHorizontal: GAP, paddingTop: 4, paddingBottom: 12, gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 6, minHeight: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  section: { fontSize: 20, fontWeight: '700', marginHorizontal: GAP, marginTop: 18, marginBottom: 2 },
});
