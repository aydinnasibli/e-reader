// The small menu over text selected with a long press: copy, look up,
// translate, share. Above the selection, or below it near the top of the screen.

import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Caret } from './hitTest';

const HEIGHT = 40;
/** Room for the start handle's knob above the selection. */
const GAP = 26;

interface Props {
  /** Where the selection starts and ends on screen. */
  start: Caret | null;
  end: Caret | null;
  /** Look up needs one word; with more selected it is left out. */
  canLookUp: boolean;
  onCopy(): void;
  onLookUp(): void;
  onTranslate(): void;
  onShare(): void;
}

export function SelectionMenu({ start, end, canLookUp, onCopy, onLookUp, onTranslate, onShare }: Props) {
  const win = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const anchor = start ?? end;
  if (!anchor) return null;
  const above = (start?.y ?? anchor.y) - GAP - HEIGHT;
  const below = end ? end.y + end.h + GAP : anchor.y + anchor.h + GAP;
  const top = above >= insets.top + 8 ? above : Math.min(below, win.height - insets.bottom - HEIGHT - 8);
  const items: [string, () => void][] = [['Copy', onCopy], ...(canLookUp ? [['Look up', onLookUp] as [string, () => void]] : []), ['Translate', onTranslate], ['Share', onShare]];
  return (
    <View style={[styles.wrap, { top }]} pointerEvents="box-none">
      <View style={styles.menu}>
        {items.map(([label, onPress], i) => (
          <Pressable
            key={label}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={label}
            style={({ pressed }) => [styles.item, i > 0 && styles.divider, pressed && styles.pressed]}>
            <Text style={styles.label}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  menu: {
    flexDirection: 'row',
    height: HEIGHT,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#2C2C2E',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  item: { paddingHorizontal: 14, justifyContent: 'center' },
  divider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: '#5A5A5E' },
  pressed: { backgroundColor: '#48484A' },
  label: { color: '#fff', fontSize: 15 },
});
