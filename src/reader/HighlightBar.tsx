// Shown while the highlight tool is on: drag over text to highlight it.
// Pick the colour here; Done turns the tool off.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Theme } from '@/lib/settings';
import { HIGHLIGHT_COLORS, type HighlightColor } from '@/ui/theme';
import { highlightColor } from './SelectionSheet';

interface Props {
  theme: Theme;
  color: HighlightColor;
  onColor(c: HighlightColor): void;
  onDone(): void;
}

export function HighlightBar({ theme, color, onColor, onDone }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { bottom: insets.bottom + 12, backgroundColor: theme.chrome, borderColor: theme.border }]}>
      <Text style={[styles.hint, { color: theme.muted }]} numberOfLines={1}>
        Drag over text
      </Text>
      {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((c) => (
        <Pressable
          key={c}
          onPress={() => onColor(c)}
          hitSlop={6}
          accessibilityLabel={`Highlight colour ${c}`}
          accessibilityState={{ selected: c === color }}
          style={[styles.dot, { backgroundColor: highlightColor(c, theme.dark), borderColor: c === color ? theme.text : 'transparent' }]}
        />
      ))}
      <Pressable onPress={onDone} hitSlop={8} style={[styles.done, { backgroundColor: theme.accent }]} accessibilityLabel="Done highlighting">
        <Text style={styles.doneText}>Done</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 16,
    paddingRight: 8,
    paddingVertical: 8,
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  hint: { fontSize: 13 },
  dot: { width: 28, height: 28, borderRadius: 14, borderWidth: 2 },
  done: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 7 },
  doneText: { color: '#fff', fontWeight: '600', fontSize: 14 },
});
