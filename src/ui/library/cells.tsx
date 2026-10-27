// The library's books as the grid and the list draw them, and the "Continue
// reading" card. Each is drawn again only when its own book changes: the
// library changes on every page turn (the place read is saved), and its
// screen is still there under the reader.

import Ionicons from '@expo/vector-icons/Ionicons';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { isFinished } from '@/lib/collections';
import { type BookEntry, useLiveBook } from '@/lib/library';
import { Cover } from '@/ui/Cover';
import { formatBytes } from '@/ui/format';
import { ProgressBar } from '@/ui/ProgressBar';
import { Tap } from '@/ui/Tap';
import { type AppColors, useAppColors } from '@/ui/theme';

/** Room between books in the grid, and the library's side margin. */
export const GAP = 16;

interface CellProps {
  book: BookEntry;
  c: AppColors;
  onOpen(b: BookEntry): void;
  onMenu(b: BookEntry): void;
}

/** "Preparing 40%" while converting (live, so only this cell redraws), or the failure. */
function useStatusText(b: BookEntry): string | null {
  const live = useLiveBook(b.id);
  if (b.status === 'processing') return `Preparing ${Math.round((live?.progress ?? 0) * 100)}%`;
  if (b.status === 'error') return 'Failed to open';
  return null;
}

/** How far it's been read, as the list says it. */
function readText(b: BookEntry): string {
  const pct = b.percent ?? 0;
  return isFinished(b) ? 'Finished' : pct > 0 ? `${Math.round(pct * 100)}% read` : 'New';
}

/**
 * What a screen reader says for a book: what the cell shows, once. Without it
 * the phone read every text in the cell, the generated cover's title and
 * author too, and the chevron icon (a character it can't say) as an empty
 * item at the end.
 */
export function bookLabel(b: BookEntry, status: string | null, more: string[] = []): string {
  return [b.title, b.author, status ?? readText(b), ...more].filter(Boolean).join(', ');
}

export const GridCell = memo(function GridCell({ book, width, c, onOpen, onMenu }: CellProps & { width: number }) {
  const status = useStatusText(book);
  const pct = book.percent ?? 0;
  const finished = isFinished(book);
  return (
    <Tap
      feedback="card"
      onPress={() => onOpen(book)}
      onLongPress={() => onMenu(book)}
      delayLongPress={350}
      style={{ width, margin: GAP / 2 }}
      accessibilityLabel={bookLabel(book, status)}>
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
                <ProgressBar value={pct} color={c.accent} track={c.border} />
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
});

export const ListRow = memo(function ListRow({ book, c, onOpen, onMenu }: CellProps) {
  const status = useStatusText(book);
  const format = book.format?.toUpperCase() ?? '';
  const size = formatBytes(book.size);
  return (
    <Pressable
      onPress={() => onOpen(book)}
      onLongPress={() => onMenu(book)}
      delayLongPress={350}
      accessibilityLabel={bookLabel(book, status, [format, size])}
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
          {status ?? readText(book)} · {format} {size}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={c.secondary} aria-hidden />
    </Pressable>
  );
});

/** The line between rows of the list (one component for the whole list, so the lines aren't made again on every redraw). */
export function ListSeparator() {
  const c = useAppColors();
  return <View style={[styles.sep, { backgroundColor: c.border }]} />;
}

export const ContinueCard = memo(function ContinueCard({ book, c, width, onOpen }: { book: BookEntry; c: AppColors; width: number; onOpen(b: BookEntry): void }) {
  const pct = book.percent ?? 0;
  return (
    <Tap feedback="card" onPress={() => onOpen(book)} style={[styles.continue, { backgroundColor: c.card, maxWidth: width }]} accessibilityLabel={`Continue reading: ${book.title}`}>
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
            <ProgressBar value={pct} color={c.accent} track={c.border} />
          </View>
          <Text style={{ color: c.secondary, fontSize: 13 }}>{Math.round(pct * 100)}%</Text>
        </View>
      </View>
    </Tap>
  );
});

const styles = StyleSheet.create({
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
  badge: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.65)', paddingVertical: 4, alignItems: 'center' },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  cellTitle: { fontSize: 13, fontWeight: '600', marginTop: 8, minHeight: 34 },
  cellMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 16 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: GAP, paddingVertical: 10, gap: 14 },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 16, fontWeight: '600' },
  sep: { height: StyleSheet.hairlineWidth, marginLeft: GAP + 64 },
});
