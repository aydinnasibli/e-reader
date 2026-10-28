// The highlight tool's bar, across the top of the screen while it's on: over
// the page's header (see toolBar), so no text is under it. A tap or a drag on
// the page highlights in the colour picked here (or takes the highlighting
// away, on a highlight); Note, Copy and Remove act on the highlight just made.

import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, Text, View } from 'react-native';
import type { Theme } from '@/lib/settings';
import { HIGHLIGHT_COLORS, type HighlightColor, highlightColor } from '@/ui/theme';
import { Tap } from '@/ui/Tap';

interface Props {
  theme: Theme;
  /** The bar's height, its buttons' row at its foot and how far up they're touched (see toolBar). */
  height: number;
  row: number;
  reach: number;
  /** Kept clear at the sides (the notch in landscape). */
  left: number;
  right: number;
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

export function HighlightBar({ theme, height, row, reach, left, right, color, made, hasNote, onColor, onNote, onCopy, onRemove, onDone }: Props) {
  // Drawn in the row at the foot, touched from higher up: the reach is inside
  // each button's parents, so a touch there arrives (Android leaves out a hit
  // area past a parent's edge).
  const slop = { top: Math.max(0, reach - row) };
  const target = [styles.target, { height: row }];
  const action = (icon: keyof typeof Ionicons.glyphMap, label: string, onPress: () => void) => (
    <Tap onPress={onPress} hitSlop={slop} accessibilityRole="button" accessibilityLabel={label} style={target}>
      <Ionicons name={icon} size={20} color={theme.text} />
    </Tap>
  );
  return (
    <View testID="highlight-bar" style={[styles.bar, { height, paddingLeft: left + 8, paddingRight: right + 8, backgroundColor: theme.chrome, borderColor: theme.border }]}>
      <View style={[styles.row, { height: reach }]}>
        {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((c) => (
          <Tap
            key={c}
            onPress={() => onColor(c)}
            hitSlop={slop}
            accessibilityLabel={`Highlight colour ${c}`}
            accessibilityState={{ selected: c === color }}
            style={target}
          >
            <View style={[styles.dot, { backgroundColor: highlightColor(c, theme.dark), borderColor: c === color ? theme.text : 'transparent' }]} />
          </Tap>
        ))}
        <View style={styles.middle}>
          {made ? (
            <>
              {action(hasNote ? 'create' : 'create-outline', hasNote ? 'Edit note' : 'Note', onNote)}
              {action('copy-outline', 'Copy', onCopy)}
              {action('trash-outline', 'Remove', onRemove)}
            </>
          ) : (
            <View style={[styles.hint, { height: row }]}>
              <Text style={[styles.hintText, { color: theme.muted }]} numberOfLines={2} maxFontSizeMultiplier={1.1}>
                Tap or drag over text to highlight
              </Text>
            </View>
          )}
        </View>
        <Tap onPress={onDone} hitSlop={slop} style={[styles.doneTarget, { height: row }]} accessibilityLabel="Done highlighting">
          <View style={[styles.done, { backgroundColor: theme.accent }]}>
            <Text style={styles.doneText} maxFontSizeMultiplier={1.2}>
              Done
            </Text>
          </View>
        </Tap>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', top: 0, left: 0, right: 0, justifyContent: 'flex-end', borderBottomWidth: StyleSheet.hairlineWidth },
  // At most this wide, so on a wide screen the buttons stay together; on a narrow one they give a little.
  row: { width: '100%', maxWidth: 480, alignSelf: 'center', flexDirection: 'row', alignItems: 'flex-end' },
  target: { width: 44, minWidth: 36, flexShrink: 1, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 22, height: 22, borderRadius: 11, borderWidth: 2 },
  middle: { flexGrow: 1, flexShrink: 1, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center' },
  hint: { flex: 1, justifyContent: 'center', paddingHorizontal: 4 },
  hintText: { fontSize: 11, lineHeight: 13, textAlign: 'center' },
  doneTarget: { justifyContent: 'center', paddingLeft: 4 },
  done: { borderRadius: 13, paddingHorizontal: 12, height: 26, justifyContent: 'center' },
  doneText: { color: '#fff', fontWeight: '600', fontSize: 13 },
});
