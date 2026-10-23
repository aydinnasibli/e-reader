// The highlight tool's panel, at the bottom while it's on. Select text on the
// page (drag over it, or tap a word or a highlight), then pick a colour to
// highlight it, or add a note, copy it or remove its highlighting.

import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Theme } from '@/lib/settings';
import { HIGHLIGHT_COLORS, type HighlightColor, highlightColor } from '@/ui/theme';

interface Props {
  theme: Theme;
  /** The colour used last (marked); with text selected, a colour highlights it. */
  color: HighlightColor;
  /** Text is selected. */
  selected: boolean;
  /** The selection is exactly one highlight, which has a note. */
  hasNote: boolean;
  /** Some of the selection is highlighted, so it can be removed. */
  canRemove: boolean;
  onColor(c: HighlightColor): void;
  onNote(): void;
  onCopy(): void;
  onRemove(): void;
  onDone(): void;
}

export function HighlightBar({ theme, color, selected, hasNote, canRemove, onColor, onNote, onCopy, onRemove, onDone }: Props) {
  const insets = useSafeAreaInsets();
  const action = (icon: keyof typeof Ionicons.glyphMap, label: string, onPress: () => void) => (
    <Pressable onPress={onPress} hitSlop={6} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.action, pressed && { opacity: 0.5 }]}>
      <Ionicons name={icon} size={20} color={theme.text} />
      <Text style={[styles.actionLabel, { color: theme.text }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
        {label}
      </Text>
    </Pressable>
  );
  return (
    <View style={[styles.panel, { bottom: insets.bottom + 12, backgroundColor: theme.chrome, borderColor: theme.border }]}>
      <View style={styles.row}>
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
      {selected ? (
        <View style={[styles.row, styles.actions, { borderColor: theme.border }]}>
          {action('create-outline', hasNote ? 'Edit note' : 'Note', onNote)}
          {action('copy-outline', 'Copy', onCopy)}
          {canRemove ? action('close-circle-outline', 'Remove', onRemove) : null}
        </View>
      ) : (
        <Text style={[styles.hint, { color: theme.muted }]} numberOfLines={2}>
          Drag over text, or tap a word or a highlight, to select it
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, justifyContent: 'center' },
  actions: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, gap: 22 },
  action: { alignItems: 'center', minWidth: 52 },
  actionLabel: { fontSize: 12, marginTop: 2 },
  hint: { fontSize: 13, textAlign: 'center' },
  dot: { width: 30, height: 30, borderRadius: 15, borderWidth: 2 },
  done: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 7, marginLeft: 4 },
  doneText: { color: '#fff', fontWeight: '600', fontSize: 14 },
});
