// The time and battery level shown while reading (the phone's status bar is
// hidden then).

import { useBatteryLevel } from 'expo-battery';
import { useEffect, useState } from 'react';
import { type StyleProp, Text, type TextStyle } from 'react-native';

export function formatClock(now: Date): string {
  return now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "82%", or null when the phone doesn't report its battery. */
export function formatBattery(level: number): string | null {
  return level >= 0 ? `${Math.round(level * 100)}%` : null;
}

/** The current time, updated on the minute. */
export function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const d = new Date();
      // Just after the next minute starts.
      timer = setTimeout(() => {
        setNow(new Date());
        schedule();
      }, 60_050 - (d.getSeconds() * 1000 + d.getMilliseconds()));
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);
  return formatClock(now);
}

export function useBattery(): string | null {
  return formatBattery(useBatteryLevel());
}

/** Each piece is its own component, so the timer and battery listener run only while shown. */
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

/** "14:32 · 82%" in one line. */
export function ClockBattery({ style }: { style?: StyleProp<TextStyle> }) {
  const level = useBattery();
  return <Text style={style}>{useClock() + (level ? ` · ${level}` : '')}</Text>;
}
