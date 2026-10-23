// A book's details: cover, title and author (editable), what the file is,
// and how the reading is going.

import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAnnotations } from '@/lib/annotations';
import { isFinished, useShelves } from '@/lib/collections';
import { loadManifest, renameBook, restoreBookTitle, useBook } from '@/lib/library';
import { bookTimeMs, readingSpeed, useStats } from '@/lib/stats';
import { Cover } from '@/ui/Cover';
import { confirmRemoveBook } from '@/ui/confirm';
import { showPrompt } from '@/ui/dialogs';
import { formatBytes, formatMinutes } from '@/ui/format';
import { useAppColors } from '@/ui/theme';
import { Tap } from '@/ui/Tap';

const FORMAT_NAMES: Record<string, string> = { epub: 'EPUB', fb2: 'FB2', txt: 'Plain text', mobi: 'MOBI', azw3: 'AZW3 (Kindle)' };
const date = (ms: number) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '—');

export default function BookDetails() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useAppColors();
  const insets = useSafeAreaInsets();
  const book = useBook(id);
  const ann = useAnnotations(id);
  const shelves = useShelves();
  useStats(); // re-render as reading time changes
  const manifest = useMemo(() => (book?.status === 'ready' ? loadManifest(id) : null), [id, book?.status]);

  if (!book) {
    return (
      <View style={[styles.center, { backgroundColor: c.bg }]}>
        <Stack.Screen options={{ title: 'Book' }} />
        <Text style={{ color: c.secondary }}>This book is no longer in the library.</Text>
      </View>
    );
  }

  const percent = book.percent ?? 0;
  const finished = isFinished(book);
  const timeMs = bookTimeMs(id);
  const leftMin = manifest && !finished ? (manifest.totalChars * (1 - percent)) / readingSpeed(id).cpm : null;
  const notes = ann.highlights.filter((h) => h.note?.trim()).length;
  const collections = shelves.collections.filter((col) => book.collections?.includes(col.id)).map((col) => col.name);

  const editTitle = () =>
    showPrompt('Title', {
      initial: book.title,
      confirm: 'Save',
      onSubmit: (title) => title.trim() && renameBook(id, { title }),
    });
  const editAuthor = () =>
    showPrompt('Author', {
      initial: book.author,
      placeholder: 'Author',
      confirm: 'Save',
      allowEmpty: true,
      onSubmit: (author) => renameBook(id, { author }),
    });
  const remove = () => confirmRemoveBook(book, () => router.back());

  const row = (label: string, value: string) => (
    <View style={[styles.row, { borderColor: c.border }]} key={label}>
      <Text style={{ color: c.secondary, fontSize: 15 }}>{label}</Text>
      <Text style={[styles.value, { color: c.text }]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );

  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 48, paddingLeft: insets.left + 20, paddingRight: insets.right + 20 }]}>
      <Stack.Screen options={{ title: 'Details', headerStyle: { backgroundColor: c.bg }, headerTintColor: c.text, headerShadowVisible: false }} />
      <View style={styles.top}>
        <Cover book={book} width={110} radius={8} />
        <View style={styles.names}>
          <Tap onPress={editTitle} accessibilityLabel="Edit title" style={styles.editable}>
            <Text style={[styles.title, { color: c.text }]}>{book.title}</Text>
            <Ionicons name="pencil" size={15} color={c.secondary} />
          </Tap>
          <Tap onPress={editAuthor} accessibilityLabel="Edit author" style={styles.editable}>
            <Text style={{ color: book.author ? c.text : c.secondary, fontSize: 16 }}>{book.author || 'Add author'}</Text>
            <Ionicons name="pencil" size={13} color={c.secondary} />
          </Tap>
          {book.titleEdited ? (
            <Tap onPress={() => restoreBookTitle(id)} hitSlop={6}>
              <Text style={{ color: c.accent, fontSize: 13 }}>Use the book’s own title</Text>
            </Tap>
          ) : null}
        </View>
      </View>

      <Tap
        onPress={() => router.push({ pathname: '/reader/[id]', params: { id } })}
        style={[styles.open, { backgroundColor: c.accent }]}
        accessibilityLabel={percent > 0 ? 'Continue reading' : 'Start reading'}>
        <Text style={{ color: c.accentText, fontSize: 16, fontWeight: '600' }}>{percent > 0 && !finished ? `Continue reading · ${Math.round(percent * 100)}%` : 'Read'}</Text>
      </Tap>

      <Text style={[styles.heading, { color: c.secondary }]}>READING</Text>
      <View style={[styles.card, { backgroundColor: c.card }]}>
        {row('Progress', finished ? 'Finished' : `${Math.round(percent * 100)}%`)}
        {row('Time spent reading', timeMs >= 30_000 ? formatMinutes(timeMs / 60_000) : '—')}
        {leftMin !== null ? row('Time left', formatMinutes(leftMin)) : null}
        {row('Highlights', String(ann.highlights.length))}
        {row('Notes', String(notes))}
        {row('Bookmarks', String(ann.bookmarks.length))}
        {row('Last opened', date(book.openedAt))}
      </View>

      <Text style={[styles.heading, { color: c.secondary }]}>FILE</Text>
      <View style={[styles.card, { backgroundColor: c.card }]}>
        {row('Format', FORMAT_NAMES[book.format ?? ''] ?? '—')}
        {row('Size', formatBytes(book.size))}
        {row('File name', book.fileName)}
        {row('Added', date(book.addedAt))}
        {manifest?.lang ? row('Language', manifest.lang) : null}
        {collections.length ? row('Collections', collections.join(', ')) : null}
        {book.status === 'processing' ? row('Status', 'Still being prepared') : null}
        {book.status === 'error' ? row('Status', 'Could not be opened') : null}
      </View>

      <Tap onPress={remove} style={styles.remove} accessibilityLabel="Remove from library">
        <Ionicons name="trash-outline" size={18} color={c.danger} />
        <Text style={{ color: c.danger, fontSize: 16 }}>Remove from library</Text>
      </Tap>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { paddingTop: 20 },
  top: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  names: { flex: 1, gap: 8, paddingTop: 4 },
  editable: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  title: { fontSize: 21, fontWeight: '700', flexShrink: 1 },
  open: { marginTop: 20, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  heading: { fontSize: 12, fontWeight: '600', marginTop: 26, marginBottom: 8, marginLeft: 4 },
  card: { borderRadius: 12, paddingHorizontal: 14 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  value: { fontSize: 15, flexShrink: 1, textAlign: 'right' },
  remove: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 28, padding: 12 },
});
