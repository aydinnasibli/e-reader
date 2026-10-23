// The time and battery level shown while reading (the phone's status bar is
// hidden then).

import Ionicons from '@expo/vector-icons/Ionicons';
import { getBatteryLevelAsync } from 'expo-battery';
import { useEffect, useRef, useState } from 'react';
import { AppState, type StyleProp, StyleSheet, Text, type TextStyle, View } from 'react-native';

export function formatClock(now: Date): string {
  return now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "82%", or null when the phone doesn't report its battery. */
export function formatBattery(level: number): string | null {
  return level >= 0 ? `${Math.round(level * 100)}%` : null;
}

/**
 * Calls `onTick` now, just after every minute starts, and when the app comes
 * back to the screen (timers stand still while the phone sleeps).
 */
function useMinuteTick(onTick: () => void) {
  const latest = useRef(onTick);
  latest.current = onTick;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      clearTimeout(timer);
      latest.current();
      const d = new Date();
      timer = setTimeout(tick, 60_050 - (d.getSeconds() * 1000 + d.getMilliseconds()));
    };
    tick();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && tick());
    return () => {
      clearTimeout(timer);
      sub.remove();
    };
  }, []);
}

export function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useMinuteTick(() => setNow(new Date()));
  return formatClock(now);
}

/**
 * The battery level (0..1, or -1 if unknown), read every minute: the battery
 * hook only updates on Android when the battery gets low or okay again, not
 * as it drains.
 */
export function useBatteryLevel(): number {
  const [level, setLevel] = useState(-1);
  useMinuteTick(() => {
    getBatteryLevelAsync().then(setLevel, () => {});
  });
  return level;
}

/** A battery symbol for a level, so the percentage isn't taken for the reading progress. */
export function batteryIcon(level: number): 'battery-full' | 'battery-half' | 'battery-dead' {
  return level >= 0.7 ? 'battery-full' : level >= 0.3 ? 'battery-half' : 'battery-dead';
}

/** Each piece is its own component, so the timers run only while shown. */
export function Clock({ style, maxScale }: { style?: StyleProp<TextStyle>; maxScale?: number }) {
  return (
    <Text numberOfLines={1} maxFontSizeMultiplier={maxScale} style={style}>
      {useClock()}
    </Text>
  );
}

/** Battery symbol and percentage; nothing when the phone doesn't say. */
export function Battery({ style, color, maxScale }: { style?: StyleProp<TextStyle>; color: string; maxScale?: number }) {
  const level = useBatteryLevel();
  const text = formatBattery(level);
  return text ? (
    <View style={styles.battery} accessible accessibilityLabel={`Battery ${text}`}>
      <Ionicons name={batteryIcon(level)} size={15} color={color} />
      <Text numberOfLines={1} maxFontSizeMultiplier={maxScale} style={style}>
        {text}
      </Text>
    </View>
  ) : null;
}

/** "14:32 · ▭ 82%", inside a line of text. */
export function ClockBattery({ color }: { color: string }) {
  const level = useBatteryLevel();
  const text = formatBattery(level);
  return (
    <Text>
      {useClock()}
      {text ? (
        <>
          {' · '}
          <Ionicons name={batteryIcon(level)} size={13} color={color} /> {text}
        </>
      ) : null}
    </Text>
  );
}

const styles = StyleSheet.create({
  battery: { flexDirection: 'row', alignItems: 'center', gap: 3 },
});
