/// <reference types="jest" />
// The phone a layout test pretends to be: window size, safe-area insets,
// text size and platform, plus stand-ins that make layout visible to the
// checker (check.ts):
//   jest.mock('react-native-safe-area-context', () => require('./env').safeArea);
//   jest.mock('react-native/Libraries/Components/Keyboard/KeyboardAvoidingView', () => require('./env').kav);
//   jest.mock('@expo/vector-icons/Ionicons', () => require('./env').Icon);

import { createElement, forwardRef } from 'react';
import { Dimensions, Platform, View, type ViewProps } from 'react-native';
import type { Device } from './check';

const g = globalThis as { __device?: Device };

export function setDevice(d: Device) {
  g.__device = d;
  const win = { width: d.width, height: d.height, scale: 3, fontScale: d.fontScale };
  Dimensions.set({ window: win, screen: win });
  Object.defineProperty(Platform, 'OS', { get: () => d.platform, configurable: true });
}

const insets = () => g.__device?.insets ?? { top: 0, bottom: 0, left: 0, right: 0 };

export const safeArea = {
  ...jest.requireActual('react-native-safe-area-context/jest/mock').default,
  useSafeAreaInsets: insets,
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: g.__device?.width ?? 390, height: g.__device?.height ?? 844 }),
};

/** KeyboardAvoidingView that tells the checker which behaviour it was given. */
const Kav = forwardRef<View, ViewProps & { behavior?: string }>(function Kav({ behavior, ...rest }, ref) {
  return createElement(View, { ...rest, ref, testID: '__kav', 'data-behavior': behavior } as ViewProps);
});
export const kav = { __esModule: true, default: Kav };

/** Icons drawn as boxes of their real size (the global test setup draws their names as text). */
function IconBox({ size = 12, name }: { size?: number; name: string }) {
  return createElement(View, { style: { width: size, height: size }, accessibilityLabel: `icon ${name}` } as ViewProps);
}
IconBox.glyphMap = {};
export const Icon = IconBox;

/**
 * Animations land at once and on the JS side: native-driven ones never move in
 * jest, which would leave panels drawn where they start (off screen). Call in
 * beforeAll.
 */
export function instantAnimations() {
  const { Animated } = require('react-native') as typeof import('react-native');
  const timing = Animated.timing;
  type Cfg = Parameters<typeof Animated.timing>[1];
  jest.spyOn(Animated, 'timing').mockImplementation((v, c: Cfg) => timing(v, { ...c, duration: 0, delay: 0, useNativeDriver: false }));
  jest.spyOn(Animated, 'spring').mockImplementation((v, c) =>
    timing(v, { toValue: (c as { toValue: number }).toValue, duration: 0, useNativeDriver: false } as Cfg),
  );
}
