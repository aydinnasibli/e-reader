// A segmented control, like the iPhone's: the chosen option sits on a thumb
// that slides over to the one tapped, with a tick.

import * as Haptics from 'expo-haptics';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Animated, type LayoutRectangle, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

interface Props<T extends string> {
  value: T;
  options: readonly T[];
  /** What an option shows; `on` is true for the chosen one. */
  render(v: T, on: boolean): ReactNode;
  label?(v: T): string;
  onPick(v: T): void;
  /** The track behind the options. */
  track: string;
  /** The thumb under the chosen option. */
  thumb: string;
  /** Options share the width equally (tabs) instead of each taking its own. */
  fill?: boolean;
  style?: ViewStyle;
  itemStyle?: ViewStyle;
}

export function Segmented<T extends string>({ value, options, render, label, onPick, track, thumb, fill, style, itemStyle }: Props<T>) {
  const [boxes, setBoxes] = useState<Record<string, LayoutRectangle>>({});
  const box = boxes[value];
  const x = useRef(new Animated.Value(0)).current;
  const w = useRef(new Animated.Value(0)).current;
  const placed = useRef(false);
  useEffect(() => {
    if (!box) return;
    if (!placed.current) {
      // First time: straight there.
      x.setValue(box.x);
      w.setValue(box.width);
      placed.current = true;
      return;
    }
    Animated.parallel([
      Animated.spring(x, { toValue: box.x, useNativeDriver: false, speed: 22, bounciness: 4 }),
      Animated.spring(w, { toValue: box.width, useNativeDriver: false, speed: 22, bounciness: 4 }),
    ]).start();
  }, [box, x, w]);

  return (
    <View style={[styles.track, { backgroundColor: track }, style]}>
      {box ? <Animated.View pointerEvents="none" style={[styles.thumb, { backgroundColor: thumb, left: x, width: w, top: box.y, height: box.height }]} /> : null}
      {options.map((o) => (
        <Pressable
          key={o}
          onPress={() => {
            if (o === value) return;
            Haptics.selectionAsync().catch(() => {});
            onPick(o);
          }}
          accessibilityRole="button"
          accessibilityLabel={label?.(o)}
          accessibilityState={{ selected: o === value }}
          onLayout={(e) => {
            const l = e.nativeEvent.layout;
            setBoxes((b) => (b[o] && b[o].x === l.x && b[o].width === l.width && b[o].height === l.height ? b : { ...b, [o]: l }));
          }}
          style={({ pressed }) => [styles.item, fill && styles.fill, itemStyle, pressed && o !== value && styles.pressed]}>
          {render(o, o === value)}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', borderRadius: 10, padding: 3 },
  thumb: {
    position: 'absolute',
    borderRadius: 8,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  item: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  fill: { flex: 1, paddingHorizontal: 4 },
  pressed: { opacity: 0.55 },
});
