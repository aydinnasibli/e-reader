// "Go to page": type a page number (or a percentage) and go there.

import { useState } from 'react';
import { StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import type { Theme } from '@/lib/settings';
import { Sheet } from '@/ui/Sheet';
import { parseGoTo } from './navigate';
import { Tap } from '@/ui/Tap';

interface Props {
  visible: boolean;
  theme: Theme;
  /**
   * The page shown and how many there are (page mode; `approx`: an estimate,
   * the book is still being converted, up to page `ready` so far); null when
   * pages aren't counted.
   */
  page: { page: number; total: number; approx?: boolean; ready?: number } | null;
  /** How far converting the book has got (percent), while it's still being converted. */
  preparing?: number | null;
  /** Where reading is now, 0..1. */
  fraction: number;
  onClose(): void;
  /** Go to this fraction of the book; by page number, `page` is the page asked for. */
  onGo(fraction: number, page?: number): void;
}

type Unit = 'page' | 'percent';
const DANGER = '#D33';

export function GoToSheet({ visible, theme, page, preparing, fraction, onClose, onGo }: Props) {
  const [unit, setUnit] = useState<Unit>('page');
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const win = useWindowDimensions();
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
    // A part not converted yet: stay here (going to the last page converted would be somewhere else).
    const ready = by === 'page' ? Number(text) <= (page?.ready ?? Infinity) : preparing == null || f <= (preparing ?? 100) / 100;
    if (!ready) {
      setProblem(`That part is still being prepared (${preparing ?? 0}%).`);
      return;
    }
    reset();
    onGo(f, by === 'page' && page ? Number(text) : undefined);
  };

  const colors = { bg: theme.chrome, text: theme.text, border: theme.border };
  // A phone on its side has little room above the keyboard: the page/percent
  // switch goes in the title row and the buttons beside the number box.
  const short = win.height < 500;
  const segment = page ? (
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
  ) : null;
  const field = (
    <View style={[styles.field, short && styles.grow, { borderColor: problem ? DANGER : theme.border, backgroundColor: theme.bg }]}>
      <TextInput
        value={text}
        onChangeText={(t) => {
          setText(t.replace(/[^\d]/g, ''));
          setProblem(null);
        }}
        placeholder={by === 'page' && page ? `1–${page.approx ? '~' : ''}${page.total}` : '0–100'}
        placeholderTextColor={theme.muted}
        keyboardType="number-pad"
        returnKeyType="go"
        onSubmitEditing={go}
        autoFocus
        maxLength={7}
        // Already big: it needn't grow much with the phone's text size.
        maxFontSizeMultiplier={1.2}
        style={[styles.input, short && styles.inputShort, { color: theme.text }]}
        accessibilityLabel={by === 'page' ? 'Page number' : 'Percentage'}
      />
      {by === 'percent' ? <Text style={[styles.unit, { color: theme.muted }]}>%</Text> : null}
    </View>
  );
  // The number pad has no return key on iPhone: these stay in view while typing.
  const buttons = (
    <>
      <Tap onPress={close} style={[styles.btn, short && styles.btnShort, { backgroundColor: theme.bg }]}>
        <Text style={{ color: theme.text, fontSize: 16 }}>Cancel</Text>
      </Tap>
      <Tap onPress={go} style={[styles.btn, short && styles.btnShort, { backgroundColor: theme.accent }]} accessibilityLabel="Go">
        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>Go</Text>
      </Tap>
    </>
  );
  return (
    <Sheet visible={visible} onClose={close} colors={colors} title="Go to page" position="top" scroll right={short ? segment : undefined}>
      <View style={[styles.body, short && styles.short]}>
        <Text style={[styles.where, { color: theme.muted }]}>
          {page ? `You're on page ${page.page} of ${page.approx ? '~' : ''}${page.total} · ${pct}%` : `You're at ${pct}%`}
        </Text>
        {short ? null : segment}
        {short ? (
          <View style={styles.buttons}>
            {field}
            {buttons}
          </View>
        ) : (
          field
        )}
        {problem ? <Text style={styles.problem}>{problem}</Text> : null}
        {short ? null : <View style={styles.buttons}>{buttons}</View>}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, gap: 14 },
  short: { gap: 6 },
  where: { fontSize: 14 },
  segment: { flexDirection: 'row', borderRadius: 9, padding: 2, alignSelf: 'flex-start' },
  segItem: { paddingHorizontal: 18, paddingVertical: 7, borderRadius: 7 },
  field: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 12, paddingHorizontal: 16 },
  input: { flex: 1, fontSize: 28, fontWeight: '600', paddingVertical: 10, textAlign: 'center' },
  inputShort: { fontSize: 22, paddingVertical: 4 },
  unit: { fontSize: 22, fontWeight: '600' },
  problem: { color: DANGER, fontSize: 14 },
  buttons: { flexDirection: 'row', gap: 10 },
  grow: { flex: 1 },
  btn: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 10 },
  btnShort: { flex: 0, justifyContent: 'center', paddingHorizontal: 18 },
});
