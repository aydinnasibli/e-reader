// "Go to page": type a page number (or a percentage) and go there.

import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { Theme } from '@/lib/settings';
import { Sheet } from '@/ui/Sheet';
import { parseGoTo } from './navigate';
import { Tap } from '@/ui/Tap';

interface Props {
  visible: boolean;
  theme: Theme;
  /** The page shown and how many there are (page mode); null when pages aren't counted. */
  page: { page: number; total: number } | null;
  /** Where reading is now, 0..1. */
  fraction: number;
  onClose(): void;
  /** Go to this fraction of the book. */
  onGo(fraction: number): void;
}

type Unit = 'page' | 'percent';
const DANGER = '#D33';

export function GoToSheet({ visible, theme, page, fraction, onClose, onGo }: Props) {
  const [unit, setUnit] = useState<Unit>('page');
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  // Scroll mode has no page numbers: percentages only.
  const by: Unit = page ? unit : 'percent';
  const pct = Math.round(fraction * 100);

  const reset = () => {
    setText('');
    setProblem(null);
  };
  const close = () => {
    reset();
    onClose();
  };
  const go = () => {
    const f = parseGoTo(by === 'percent' ? `${text}%` : text, page?.total ?? null);
    if (f === null) {
      setProblem(by === 'page' && page ? `Enter a page from 1 to ${page.total}.` : 'Enter a percentage from 0 to 100.');
      return;
    }
    reset();
    onGo(f);
  };

  const colors = { bg: theme.chrome, text: theme.text, border: theme.border };
  return (
    <Sheet visible={visible} onClose={close} colors={colors} title="Go to page" position="top">
      <View style={styles.body}>
        <Text style={[styles.where, { color: theme.muted }]}>
          {page ? `You're on page ${page.page} of ${page.total} · ${pct}%` : `You're at ${pct}%`}
        </Text>
        {page ? (
          <View style={[styles.segment, { backgroundColor: theme.bg }]}>
            {(['page', 'percent'] as const).map((u) => (
              <Tap
                key={u}
                haptic="select"
                onPress={() => {
                  setUnit(u);
                  reset();
                }}
                accessibilityLabel={u === 'page' ? 'By page number' : 'By percentage'}
                accessibilityState={{ selected: by === u }}
                style={[styles.segItem, by === u && { backgroundColor: theme.accent }]}>
                <Text style={{ color: by === u ? '#fff' : theme.text, fontSize: 14, fontWeight: '600' }}>{u === 'page' ? 'Page' : 'Percent'}</Text>
              </Tap>
            ))}
          </View>
        ) : null}
        <View style={[styles.field, { borderColor: problem ? DANGER : theme.border, backgroundColor: theme.bg }]}>
          <TextInput
            value={text}
            onChangeText={(t) => {
              setText(t.replace(/[^\d]/g, ''));
              setProblem(null);
            }}
            placeholder={by === 'page' && page ? `1–${page.total}` : '0–100'}
            placeholderTextColor={theme.muted}
            keyboardType="number-pad"
            returnKeyType="go"
            onSubmitEditing={go}
            autoFocus
            maxLength={7}
            style={[styles.input, { color: theme.text }]}
            accessibilityLabel={by === 'page' ? 'Page number' : 'Percentage'}
          />
          {by === 'percent' ? <Text style={[styles.unit, { color: theme.muted }]}>%</Text> : null}
        </View>
        {problem ? <Text style={styles.problem}>{problem}</Text> : null}
        <View style={styles.buttons}>
          <Tap onPress={close} style={[styles.btn, { backgroundColor: theme.bg }]}>
            <Text style={{ color: theme.text, fontSize: 16 }}>Cancel</Text>
          </Tap>
          <Tap onPress={go} style={[styles.btn, { backgroundColor: theme.accent }]} accessibilityLabel="Go">
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>Go</Text>
          </Tap>
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, gap: 14 },
  where: { fontSize: 14 },
  segment: { flexDirection: 'row', borderRadius: 9, padding: 2, alignSelf: 'flex-start' },
  segItem: { paddingHorizontal: 18, paddingVertical: 7, borderRadius: 7 },
  field: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 12, paddingHorizontal: 16 },
  input: { flex: 1, fontSize: 28, fontWeight: '600', paddingVertical: 10, textAlign: 'center' },
  unit: { fontSize: 22, fontWeight: '600' },
  problem: { color: DANGER, fontSize: 14 },
  buttons: { flexDirection: 'row', gap: 10 },
  btn: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 10 },
});
