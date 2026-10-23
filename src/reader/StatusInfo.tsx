// The time and battery level shown while reading (the phone's status bar is
// hidden then).

import { getBatteryLevelAsync } from 'expo-battery';
import { useEffect, useRef, useState } from 'react';
import { AppState, type StyleProp, Text, type TextStyle } from 'react-native';

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
 * The battery level, read every minute: the battery hook only updates on
 * Android when the battery gets low or okay again, not as it drains.
 */
export function useBattery(): string | null {
  const [level, setLevel] = useState(-1);
  useMinuteTick(() => {
    getBatteryLevelAsync().then(setLevel, () => {});
  });
  return formatBattery(level);
}

/** Each piece is its own component, so the timers run only while shown. */
export function Clock({ style, maxScale }: { style?: StyleProp<TextStyle>; maxScale?: number }) {
  return (
    <Text numberOfLines={1} maxFontSizeMultiplier={maxScale} style={style}>
      {useClock()}
    </Text>
  );
}

export function Battery({ style, maxScale }: { style?: StyleProp<TextStyle>; maxScale?: number }) {
  const level = useBattery();
  return level ? (
    <Text numberOfLines={1} maxFontSizeMultiplier={maxScale} style={style} accessibilityLabel={`Battery ${level}`}>
      {level}
    </Text>
  ) : null;
}

/** "14:32 · 82%", inside a line of text. */
export function ClockBattery() {
  const level = useBattery();
  return <Text>{useClock() + (level ? ` · ${level}` : '')}</Text>;
}
