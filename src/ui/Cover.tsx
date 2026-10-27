import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';
import { type BookEntry, coverUri } from '@/lib/library';

const AUTHOR_LINE = 15;
const PALETTE = ['#4E6E9E', '#9E6A4E', '#5E8A5A', '#7E5E98', '#98884E', '#4E8E92', '#8E4E62'];

/** How far a generated cover's text sits in from its padding, clear of the spine. */
const TEXT_INSET = 4;
/** About how wide a bold letter is, in ems (the wide ones are wider, the narrow ones narrower). */
const LETTER_EM = 0.6;

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * A title as a generated cover draws it. Titles made from file names
 * ("big-english-60mb", "istanbul-1254") are long words joined by "-", "." or
 * "_", where lines aren't allowed to break (or not before a digit), so a word
 * wider than the cover was split anywhere: "istanbul-125 / 4". Lines may now
 * break after those marks, and the size comes down until the longest word
 * left fits on a line (not below `min`).
 */
export function coverTitle(title: string, boxWidth: number, size: number, min: number): { text: string; fontSize: number } {
  const text = title.replace(/([-._])(?=\S)/g, '$1​');
  const longest = Math.max(1, ...text.split(/[\s​]+/).map((w) => w.length));
  return { text, fontSize: Math.max(min, Math.min(size, Math.floor(boxWidth / (longest * LETTER_EM)))) };
}

/** Book cover, or a generated one with the title when the book has none. */
export function Cover({ book, width, radius = 6 }: { book: BookEntry; width: number; radius?: number }) {
  const uri = coverUri(book);
  const height = Math.round(width * 1.5);
  const small = width < 70;
  // The generated cover is a picture of the title, at a size that fits its
  // longest word (the real title is shown with it): as many lines as fit,
  // ending in "…", never cut off at the bottom edge.
  const pad = small ? 5 : 10;
  // (Not below 8 on the bigger covers: the "Continue reading" card's is 78 wide, and a word like
  // "(Simülatör)" needs 8 to fit there.)
  const title = coverTitle(book.title, width - 2 * pad - TEXT_INSET, small ? 9 : 14, small ? 6 : 8);
  const titleSize = title.fontSize;
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
        // A picture of the title, not text to read out: the title is beside it.
        <View style={[styles.generated, { padding: pad }]} aria-hidden>
          <View style={styles.spine} />
          <Text style={[styles.title, { fontSize: titleSize, lineHeight: titleLine }]} numberOfLines={titleLines} maxFontSizeMultiplier={1}>
            {title.text}
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
  title: { color: '#fff', fontWeight: '700', marginLeft: TEXT_INSET },
  author: { color: 'rgba(255,255,255,0.8)', fontSize: 12, lineHeight: AUTHOR_LINE, marginLeft: TEXT_INSET },
});
