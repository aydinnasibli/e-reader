import { Image } from 'expo-image';
import { Stack, router, useTheme } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { type BookEntry, coverUri, deleteBook, importBooks, useLibrary } from '@/lib/library';

const COLUMNS = 3;
const GAP = 14;
const PLACEHOLDER_COLORS = ['#5B7DB1', '#B1735B', '#6E9E6B', '#8E6BA8', '#A8955B', '#5BA3A8'];

export default function Library() {
  const books = useLibrary();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const [importing, setImporting] = useState(false);
  const sorted = useMemo(() => [...books].sort((a, b) => b.openedAt - a.openedAt), [books]);
  const itemWidth = (width - GAP * (COLUMNS + 1)) / COLUMNS;

  const add = async () => {
    setImporting(true);
    try {
      const res = await importBooks();
      if (res.skipped.length) {
        Alert.alert('Some files were skipped', `Only EPUB, FB2 and TXT books are supported:\n\n${res.skipped.join('\n')}`);
      }
    } catch (e) {
      Alert.alert('Import failed', e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const confirmDelete = (b: BookEntry) =>
    Alert.alert('Remove book?', `"${b.title}" will be removed from this phone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => deleteBook(b.id) },
    ]);

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () =>
            importing ? (
              <ActivityIndicator />
            ) : (
              <Pressable onPress={add} hitSlop={12}>
                <Text style={{ color: colors.primary, fontSize: 17 }}>Add</Text>
              </Pressable>
            ),
        }}
      />
      <FlatList
        data={sorted}
        key={COLUMNS}
        numColumns={COLUMNS}
        keyExtractor={(b) => b.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: GAP / 2, paddingBottom: 40, flexGrow: 1 }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyTitle, { color: colors.text }]}>No books yet</Text>
            <Text style={[styles.emptyText, { color: colors.text }]}>Tap Add to import EPUB, FB2 or TXT files. Big files are fine.</Text>
            <Pressable onPress={add} style={[styles.emptyBtn, { backgroundColor: colors.primary }]}>
              <Text style={styles.emptyBtnText}>Add books</Text>
            </Pressable>
          </View>
        }
        renderItem={({ item }) => (
          <BookCell book={item} width={itemWidth} textColor={String(colors.text)} onLongPress={() => confirmDelete(item)} />
        )}
      />
    </>
  );
}

function BookCell({ book, width, textColor, onLongPress }: { book: BookEntry; width: number; textColor: string; onLongPress(): void }) {
  const cover = coverUri(book);
  const height = Math.round(width * 1.5);
  const color = PLACEHOLDER_COLORS[book.id.charCodeAt(book.id.length - 1) % PLACEHOLDER_COLORS.length];
  const percent = Math.round((book.percent ?? 0) * 100);
  const open = () => {
    if (book.status === 'error') {
      Alert.alert("Couldn't open this book", book.error ?? 'Unknown error', [
        { text: 'OK' },
        { text: 'Remove', style: 'destructive', onPress: () => deleteBook(book.id) },
      ]);
      return;
    }
    router.push({ pathname: '/reader/[id]', params: { id: book.id } });
  };

  return (
    <Pressable onPress={open} onLongPress={onLongPress} style={{ width, margin: GAP / 2 }}>
      <View style={[styles.cover, { height, backgroundColor: color }]}>
        {cover ? (
          <Image source={{ uri: cover }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderTitle} numberOfLines={5}>
              {book.title}
            </Text>
            {book.author ? (
              <Text style={styles.placeholderAuthor} numberOfLines={2}>
                {book.author}
              </Text>
            ) : null}
          </View>
        )}
        {book.status === 'processing' && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Preparing {Math.round(book.progress * 100)}%</Text>
          </View>
        )}
        {book.status === 'error' && (
          <View style={[styles.badge, { backgroundColor: '#B3261E' }]}>
            <Text style={styles.badgeText}>Failed</Text>
          </View>
        )}
      </View>
      <View style={[styles.track, { backgroundColor: textColor + '22' }]}>
        <View style={[styles.fill, { width: `${percent}%` }]} />
      </View>
      <Text numberOfLines={2} style={[styles.title, { color: textColor }]}>
        {book.title}
      </Text>
      {book.author ? (
        <Text numberOfLines={1} style={[styles.author, { color: textColor }]}>
          {book.author}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cover: { borderRadius: 6, overflow: 'hidden', justifyContent: 'flex-end' },
  placeholder: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, padding: 10, justifyContent: 'space-between' },
  placeholderTitle: { color: '#fff', fontSize: 14, fontWeight: '700' },
  placeholderAuthor: { color: '#ffffffcc', fontSize: 12 },
  badge: { backgroundColor: 'rgba(0,0,0,0.65)', paddingVertical: 4, alignItems: 'center' },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  track: { height: 3, borderRadius: 2, marginTop: 6, overflow: 'hidden' },
  fill: { height: 3, backgroundColor: '#2F6FEB' },
  title: { fontSize: 13, fontWeight: '600', marginTop: 5 },
  author: { fontSize: 12, opacity: 0.6, marginTop: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  emptyTitle: { fontSize: 20, fontWeight: '700' },
  emptyText: { fontSize: 15, textAlign: 'center', opacity: 0.7 },
  emptyBtn: { marginTop: 10, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 },
  emptyBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
