// The menu over text selected with a long press, like the iPhone's own:
// Copy, Look Up, Translate, Share in a dark rounded bar, with an arrow
// pointing at the selection. Above it, or below it near the top of the screen.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Caret } from './hitTest';

const HEIGHT = 38;
/** The arrow is a square turned 45°, centred on the bar's edge; its tip sticks out this far. */
const SIDE = 12;
const ARROW = Math.ceil(SIDE * Math.SQRT1_2);
/** Room for a handle's knob between the text and the arrow. */
const KNOB_ROOM = 18;
const EDGE = 8;
const BG = '#1C1C1E';

interface Props {
  /** Where the selection starts and ends on screen. */
  start: Caret | null;
  end: Caret | null;
  /** Look Up needs one word; with more selected it is left out. */
  canLookUp: boolean;
  onCopy(): void;
  onLookUp(): void;
  onTranslate(): void;
  onShare(): void;
}

export function SelectionMenu({ start, end, canLookUp, onCopy, onLookUp, onTranslate, onShare }: Props) {
  const win = useWindowDimensions();
  const insets = useSafeAreaInsets();
  /** The menu's width, once laid out (it's hidden until then, to appear in the right place). */
  const [menuWidth, setMenuWidth] = useState(0);
  const first = start ?? end;
  if (!first) return null;

  // Over the middle of the selection when it's on one line; over the middle of the text otherwise.
  const oneLine = !!start && !!end && Math.abs(start.y - end.y) < 1;
  const anchorX = oneLine ? (start.x + end.x) / 2 : start && end ? win.width / 2 : first.x;
  const minLeft = insets.left + EDGE;
  const maxLeft = win.width - insets.right - EDGE - menuWidth;
  const left = Math.max(minLeft, Math.min(maxLeft, anchorX - menuWidth / 2));
  const arrowX = Math.max(14, Math.min(menuWidth - 14, anchorX - left));

  const aboveTop = (start ?? first).y - KNOB_ROOM - ARROW - HEIGHT;
  const above = aboveTop >= insets.top + EDGE;
  const last = end ?? first;
  const top = above ? aboveTop : Math.min(last.y + last.h + KNOB_ROOM + ARROW, win.height - insets.bottom - HEIGHT - EDGE);

  const items: [string, () => void][] = [['Copy', onCopy]];
  if (canLookUp) items.push(['Look Up', onLookUp]);
  items.push(['Translate', onTranslate], ['Share', onShare]);

  return (
    // Full width, so the menu's own width is never squeezed by where it sits.
    <View pointerEvents="box-none" style={[styles.wrap, { top }]}>
      <View style={{ marginLeft: left, opacity: menuWidth ? 1 : 0 }} onLayout={(e) => setMenuWidth(e.nativeEvent.layout.width)}>
        <View style={styles.menu}>
          {items.map(([label, onPress], i) => (
            <Pressable
              key={label}
              onPress={onPress}
              accessibilityRole="button"
              accessibilityLabel={label}
              style={({ pressed }) => [styles.item, i === 0 && styles.first, i === items.length - 1 && styles.last, pressed && styles.pressed]}>
              {i > 0 ? <View style={styles.divider} /> : null}
              <Text style={styles.label} numberOfLines={1} maxFontSizeMultiplier={1.2}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
        {/* Half hidden behind the bar: the arrow. */}
        <View style={[styles.arrow, { top: above ? HEIGHT - SIDE / 2 : -SIDE / 2, left: arrowX - SIDE / 2 }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, flexDirection: 'row' },
  menu: {
    flexDirection: 'row',
    height: HEIGHT,
    borderRadius: 10,
    backgroundColor: BG,
    zIndex: 1,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  item: { justifyContent: 'center', paddingHorizontal: 13 },
  first: { borderTopLeftRadius: 10, borderBottomLeftRadius: 10 },
  last: { borderTopRightRadius: 10, borderBottomRightRadius: 10 },
  pressed: { backgroundColor: '#3A3A3C' },
  divider: { position: 'absolute', left: 0, top: 9, bottom: 9, width: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.28)' },
  label: { color: '#fff', fontSize: 15, fontWeight: '500', letterSpacing: -0.2 },
  arrow: {
    position: 'absolute',
    width: SIDE,
    height: SIDE,
    backgroundColor: BG,
    borderRadius: 2,
    transform: [{ rotate: '45deg' }],
    elevation: 7,
  },
});
