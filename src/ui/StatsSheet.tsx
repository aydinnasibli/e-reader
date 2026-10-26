import { StyleSheet, Text, View } from 'react-native';
import { isFinished } from '@/lib/collections';
import { useLibrary } from '@/lib/library';
import { dayKey, readingSpeed, useStats } from '@/lib/stats';
import { formatMinutes } from './format';
import { measure } from './layout';
import { Sheet } from './Sheet';
import { useAppColors } from './theme';

/** Average characters per word, to show speed as words per minute. */
const CHARS_PER_WORD = 6;

export function StatsSheet({ visible, onClose }: { visible: boolean; onClose(): void }) {
  const c = useAppColors();
  const stats = useStats();
  const books = useLibrary();

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    return { label: d.toLocaleDateString(undefined, { weekday: 'narrow' }), ms: stats.days[dayKey(d)] ?? 0 };
  });
  const maxDay = Math.max(...days.map((d) => d.ms), 1);
  const totalMs = Object.values(stats.books).reduce((a, b) => a + b.ms, 0);
  const weekMs = days.reduce((a, d) => a + d.ms, 0);
  const todayMs = days[6].ms;
  const speed = readingSpeed();
  const wpm = Math.round(speed.cpm / CHARS_PER_WORD);
  const measured = speed.measured;
  const finished = books.filter(isFinished).length;

  const tile = (label: string, value: string) => (
    <View style={[styles.tile, { backgroundColor: c.card }]}>
      <Text style={[styles.value, { color: c.text }]}>{value}</Text>
      <Text style={[styles.tileLabel, { color: c.secondary }]}>{label}</Text>
    </View>
  );

  return (
    <Sheet visible={visible} onClose={onClose} colors={{ bg: c.elevated, text: c.text, border: c.border }} title="Reading stats" scroll>
      <View style={styles.grid}>
        {tile('Today', todayMs ? formatMinutes(todayMs / 60_000) : '—')}
        {tile('Last 7 days', weekMs ? formatMinutes(weekMs / 60_000) : '—')}
        {tile('All time', totalMs ? formatMinutes(totalMs / 60_000) : '—')}
        {tile(measured ? 'Words / minute' : 'Words / minute (est.)', String(wpm))}
        {tile('Books finished', String(finished))}
        {tile('In library', String(books.length))}
      </View>
      <View style={styles.chart}>
        {days.map((d, i) => (
          <View key={i} style={styles.barCol}>
            <View style={[styles.barTrack, { backgroundColor: c.chip }]}>
              <View style={[styles.bar, { height: `${Math.round((d.ms / maxDay) * 100)}%`, backgroundColor: i === 6 ? c.accent : c.secondary }]} />
            </View>
            <Text style={{ color: c.secondary, fontSize: 12, marginTop: 6 }}>{d.label}</Text>
          </View>
        ))}
      </View>
      <Text style={[styles.note, { color: c.secondary }]}>
        Time counts while a book is open in front of you: breaks, other apps and flipping quickly through pages don’t count. Speed comes from pages read at a normal pace, and makes the “time left” estimates fit you.
      </Text>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 14, gap: 10 },
  tile: { width: '31%', flexGrow: 1, borderRadius: 14, padding: 12 },
  value: { fontSize: 20, fontWeight: '700' },
  tileLabel: { fontSize: 12, marginTop: 4 },
  chart: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 24, paddingTop: 22, height: 150 },
  barCol: { alignItems: 'center', flex: 1 },
  barTrack: { flex: 1, width: 14, borderRadius: 7, justifyContent: 'flex-end', overflow: 'hidden' },
  bar: { width: 14, borderRadius: 7 },
  // Kept to a readable line length when the sheet is wide.
  note: { fontSize: 12, marginHorizontal: 20, paddingTop: 16, lineHeight: 17, maxWidth: measure(12) },
});
