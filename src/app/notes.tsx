// Every highlight and note across the library: search, open at the spot,
// copy/share/delete, and export as a Markdown file.

import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { Stack, router } from 'expo-router';
import { useMemo, useState } from 'react';
import { SectionList, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { type Highlight, getAnnotations, removeHighlight, useAnnotationsVersion } from '@/lib/annotations';
import { exportFileName, notesMarkdown } from '@/lib/exportNotes';
import { type BookEntry, useLibrary } from '@/lib/library';
import { shareTextFile } from '@/lib/shareText';
import { confirmDeleteHighlight, hasNote } from '@/ui/confirm';
import { showActions } from '@/ui/dialogs';
import { highlightColor, useAppColors } from '@/ui/theme';
import { Tap } from '@/ui/Tap';

interface Section {
  book: BookEntry;
  data: Highlight[];
}

const exportBooks = (sections: Section[]) =>
  sections.map((s) => ({ title: s.book.title, author: s.book.author, highlights: s.data }));

export default function NotesScreen() {
  const c = useAppColors();
  const insets = useSafeAreaInsets();
  const books = useLibrary();
  const version = useAnnotationsVersion();
  const [query, setQuery] = useState('');
  const [notesOnly, setNotesOnly] = useState(false);

  // Books with highlights, most recently read first; highlights in reading order.
  const all = useMemo<Section[]>(
    () =>
      [...books]
        .sort((a, b) => b.openedAt - a.openedAt)
        .map((book) => ({ book, data: getAnnotations(book.id).highlights }))
        .filter((s) => s.data.length),
    [books, version], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const sections = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return all
      .map((s) => ({
        ...s,
        data: s.data.filter(
          (h) =>
            (!notesOnly || !!h.note?.trim()) &&
            (!q ||
              h.text.toLocaleLowerCase().includes(q) ||
              (h.note ?? '').toLocaleLowerCase().includes(q) ||
              s.book.title.toLocaleLowerCase().includes(q) ||
              (h.chapter ?? '').toLocaleLowerCase().includes(q)),
        ),
      }))
      .filter((s) => s.data.length);
  }, [all, query, notesOnly]);
  const count = all.reduce((n, s) => n + s.data.length, 0);

  const open = (book: BookEntry, h: Highlight) => router.push({ pathname: '/reader/[id]', params: { id: book.id, b: String(h.b), o: String(h.s) } });
  const menu = (book: BookEntry, h: Highlight) =>
    showActions(undefined, [
      { label: 'Open in book', icon: 'book-outline', onPress: () => open(book, h) },
      { label: 'Copy', icon: 'copy-outline', onPress: () => void Clipboard.setStringAsync(h.note ? `${h.text}\n\n${h.note}` : h.text) },
      { label: 'Share', icon: 'share-outline', onPress: () => void Share.share({ message: `“${h.text}”\n— ${book.title}${h.note ? `\n\n${h.note}` : ''}` }) },
      { label: 'Delete highlight', icon: 'trash-outline', destructive: true, onPress: () => confirmDeleteHighlight(hasNote(h), () => removeHighlight(book.id, h.id)) },
    ]);
  const exportAll = () => void shareTextFile('Highlights.md', notesMarkdown(exportBooks(sections)));

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen
        options={{
          title: 'Highlights & notes',
          headerStyle: { backgroundColor: c.bg },
          headerTintColor: c.text,
          headerShadowVisible: false,
          headerRight: () =>
            count ? (
              <Tap onPress={exportAll} hitSlop={10} accessibilityLabel="Export highlights">
                <Ionicons name="share-outline" size={24} color={c.accent} />
              </Tap>
            ) : null,
        }}
      />
      {count ? (
        <View style={styles.tools}>
          <View style={[styles.search, { backgroundColor: c.chip }]}>
            <Ionicons name="search" size={16} color={c.secondary} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search highlights and notes"
              placeholderTextColor={c.secondary}
              style={[styles.input, { color: c.text }]}
              clearButtonMode="while-editing"
              autoCorrect={false}
            />
          </View>
          <Tap
            haptic="select"
            onPress={() => setNotesOnly((v) => !v)}
            style={[styles.chip, { backgroundColor: notesOnly ? c.accent : c.chip }]}
            accessibilityState={{ selected: notesOnly }}>
            <Text style={{ color: notesOnly ? c.accentText : c.text, fontSize: 13, fontWeight: '600' }}>With notes</Text>
          </Tap>
        </View>
      ) : null}
      <SectionList
        sections={sections}
        keyExtractor={(h) => h.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 40, paddingLeft: insets.left, paddingRight: insets.right }}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHead}>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={[styles.bookTitle, { color: c.text }]}>
                {section.book.title}
              </Text>
              <Text style={{ color: c.secondary, fontSize: 13 }}>
                {section.data.length} {section.data.length === 1 ? 'highlight' : 'highlights'}
              </Text>
            </View>
            <Tap
              onPress={() => void shareTextFile(exportFileName(section.book.title), notesMarkdown(exportBooks([section])))}
              hitSlop={10}
              accessibilityLabel={`Export ${section.book.title}`}>
              <Ionicons name="share-outline" size={20} color={c.secondary} />
            </Tap>
          </View>
        )}
        renderItem={({ item: h, section }) => (
          <Tap
            feedback="card"
            onPress={() => open(section.book, h)}
            onLongPress={() => menu(section.book, h)}
            style={[styles.row, { backgroundColor: c.card }]}>
            <View style={[styles.swatch, { backgroundColor: highlightColor(h.color, c.dark) }]} />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={4} style={[styles.quote, { color: c.text }]}>
                {h.text}
              </Text>
              {h.note ? (
                <Text style={[styles.note, { color: c.text, borderColor: c.border }]}>
                  <Ionicons name="create-outline" size={13} color={c.secondary} /> {h.note}
                </Text>
              ) : null}
              <Text numberOfLines={1} style={{ color: c.secondary, fontSize: 12, marginTop: 6 }}>
                {[h.chapter, new Date(h.createdAt).toLocaleDateString()].filter(Boolean).join(' · ')}
              </Text>
            </View>
          </Tap>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name={count ? 'search-outline' : 'color-wand-outline'} size={48} color={c.secondary} />
            <Text style={[styles.emptyTitle, { color: c.text }]}>{count ? 'Nothing matches' : 'No highlights yet'}</Text>
            <Text style={{ color: c.secondary, textAlign: 'center', lineHeight: 20 }}>
              {count
                ? 'Try other words, or show highlights without notes too.'
                : 'While reading, use Highlight in the menu and drag over text, or long-press a word.'}
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  tools: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  search: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 10, paddingHorizontal: 10 },
  input: { flex: 1, fontSize: 15, paddingVertical: 8 },
  chip: { borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8, gap: 12 },
  bookTitle: { fontSize: 17, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 12, marginHorizontal: 16, marginBottom: 8, borderRadius: 12, padding: 12 },
  swatch: { width: 4, borderRadius: 2 },
  quote: { fontSize: 15, lineHeight: 21 },
  note: { fontSize: 14, lineHeight: 20, marginTop: 8, paddingLeft: 8, borderLeftWidth: 2, fontStyle: 'italic' },
  empty: { alignItems: 'center', padding: 40, gap: 10, marginTop: 60 },
  emptyTitle: { fontSize: 18, fontWeight: '700' },
});
