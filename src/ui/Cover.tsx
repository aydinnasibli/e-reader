import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';
import { type BookEntry, coverUri } from '@/lib/library';

const AUTHOR_LINE = 15;
const PALETTE = ['#4E6E9E', '#9E6A4E', '#5E8A5A', '#7E5E98', '#98884E', '#4E8E92', '#8E4E62'];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Book cover, or a generated one with the title when the book has none. */
export function Cover({ book, width, radius = 6 }: { book: BookEntry; width: number; radius?: number }) {
  const uri = coverUri(book);
  const height = Math.round(width * 1.5);
  const small = width < 70;
  // The generated cover is a picture of the title, at a fixed size (the real
  // title is shown with it): as many lines as fit, ending in "…", never cut
  // off at the bottom edge.
  const pad = small ? 5 : 10;
  const titleSize = small ? 9 : 14;
  const titleLine = Math.round(titleSize * 1.25);
  const author = !small && !!book.author;
  const authorLines = author ? 2 : 0;
  const titleLines = Math.max(1, Math.min(small ? 4 : 6, Math.floor((height - 2 * pad - authorLines * AUTHOR_LINE - 4) / titleLine)));
  return (
    <View style={[styles.box, { width, height, borderRadius: radius, backgroundColor: PALETTE[hash(book.id) % PALETTE.length] }]}>
      {uri ? (
        // recyclingKey: a list reuses this view for another book while scrolling;
        // without it the old book's cover shows until the new one has loaded.
        <Image source={{ uri }} recyclingKey={book.id} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
      ) : (
        <View style={[styles.generated, { padding: pad }]}>
          <View style={styles.spine} />
          <Text style={[styles.title, { fontSize: titleSize, lineHeight: titleLine }]} numberOfLines={titleLines} maxFontSizeMultiplier={1}>
            {book.title}
          </Text>
          {author ? (
            <Text style={styles.author} numberOfLines={authorLines} maxFontSizeMultiplier={1}>
              {book.author}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  generated: { flex: 1, justifyContent: 'space-between' },
  spine: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, backgroundColor: 'rgba(0,0,0,0.15)' },
  title: { color: '#fff', fontWeight: '700', marginLeft: 4 },
  author: { color: 'rgba(255,255,255,0.8)', fontSize: 12, lineHeight: AUTHOR_LINE, marginLeft: 4 },
});
