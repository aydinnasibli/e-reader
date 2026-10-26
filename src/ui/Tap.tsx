// A button that answers the finger: it dims and shrinks a little while held
// (or only dims, for wide rows), and can give a light haptic tick. Use it for
// every control; plain Pressable is for areas like the page itself.

import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Animated, type GestureResponderEvent, Pressable, type PressableProps, type StyleProp, StyleSheet, type ViewStyle } from 'react-native';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface TapProps extends Omit<PressableProps, 'style'> {
  style?: StyleProp<ViewStyle>;
  /** 'scale': dims and shrinks (buttons, chips, swatches). 'card': less of both (big cards, covers). 'dim': only dims (wide rows). */
  feedback?: 'scale' | 'card' | 'dim';
  /** 'select': a tick, for picking an option. 'light': a tap, for actions that change something. */
  haptic?: 'select' | 'light';
}

const PRESSED = { scale: { opacity: 0.7, scale: 0.94 }, card: { opacity: 0.85, scale: 0.97 }, dim: { opacity: 0.5, scale: 1 } };

export function Tap({ style, feedback = 'scale', haptic, onPressIn, onPressOut, onPress, ...rest }: TapProps) {
  // Held in state, not a ref: it's read while drawing (the animated style).
  const [p] = useState(() => new Animated.Value(0));
  const to = (v: number) => Animated.timing(p, { toValue: v, duration: v ? 70 : 160, useNativeDriver: true }).start();
  const { opacity, scale } = PRESSED[feedback];
  // A button that is faded already (disabled) fades further from there.
  const base = Number(StyleSheet.flatten(style)?.opacity ?? 1);
  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(e: GestureResponderEvent) => {
        to(1);
        onPressIn?.(e);
      }}
      onPressOut={(e: GestureResponderEvent) => {
        to(0);
        onPressOut?.(e);
      }}
      onPress={
        onPress &&
        ((e: GestureResponderEvent) => {
          if (haptic === 'select') Haptics.selectionAsync().catch(() => {});
          else if (haptic === 'light') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
          onPress(e);
        })
      }
      style={[
        style,
        {
          opacity: p.interpolate({ inputRange: [0, 1], outputRange: [base, base * opacity] }),
          transform: scale === 1 ? undefined : [{ scale: p.interpolate({ inputRange: [0, 1], outputRange: [1, scale] }) }],
        },
      ]}
    />
  );
}
