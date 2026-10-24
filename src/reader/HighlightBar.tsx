// The highlight tool's panel, at the bottom while it's on. A tap or a drag on
// the page highlights in the colour picked here (or takes the highlighting
// away, on a highlight); Note, Copy and Remove act on the highlight just made.

import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Theme } from '@/lib/settings';
import { HIGHLIGHT_COLORS, type HighlightColor, highlightColor } from '@/ui/theme';
import { Tap } from '@/ui/Tap';

interface Props {
  theme: Theme;
  /** The colour new highlights get (marked). */
  color: HighlightColor;
  /** A highlight was just made: Note, Copy and Remove are for it. */
  made: boolean;
  /** The highlight just made has a note. */
  hasNote: boolean;
  onColor(c: HighlightColor): void;
  onNote(): void;
  onCopy(): void;
  onRemove(): void;
  onDone(): void;
}

export function HighlightBar({ theme, color, made, hasNote, onColor, onNote, onCopy, onRemove, onDone }: Props) {
  const insets = useSafeAreaInsets();
  const action = (icon: keyof typeof Ionicons.glyphMap, label: string, onPress: () => void) => (
    <Tap onPress={onPress} hitSlop={6} accessibilityRole="button" accessibilityLabel={label} style={styles.action}>
      <Ionicons name={icon} size={20} color={theme.text} />
      <Text style={[styles.actionLabel, { color: theme.text }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
        {label}
      </Text>
    </Tap>
  );
  return (
    <View style={[styles.panel, { bottom: insets.bottom + 12, backgroundColor: theme.chrome, borderColor: theme.border }]}>
      <View style={styles.row}>
        {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((c) => (
          <Tap
            key={c}
            onPress={() => onColor(c)}
            hitSlop={6}
            accessibilityLabel={`Highlight colour ${c}`}
            accessibilityState={{ selected: c === color }}
            style={[styles.dot, { backgroundColor: highlightColor(c, theme.dark), borderColor: c === color ? theme.text : 'transparent' }]}
          />
        ))}
        <Tap onPress={onDone} hitSlop={8} style={[styles.done, { backgroundColor: theme.accent }]} accessibilityLabel="Done highlighting">
          <Text style={styles.doneText}>Done</Text>
        </Tap>
      </View>
      {made ? (
        <View style={[styles.row, styles.actions, { borderColor: theme.border }]}>
          {action('create-outline', hasNote ? 'Edit note' : 'Note', onNote)}
          {action('copy-outline', 'Copy', onCopy)}
          {action('close-circle-outline', 'Remove', onRemove)}
        </View>
      ) : (
        <Text style={[styles.hint, { color: theme.muted }]} numberOfLines={2}>
          Tap or drag over text to highlight it; on a highlight, to remove it
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
