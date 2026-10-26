// Control for auto page turn / auto-scroll: speed, pause/resume, stop, and
// (page mode) a line filling up until the next page turns.

import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Theme } from '@/lib/settings';
import { Tap } from '@/ui/Tap';

interface Props {
  theme: Theme;
  /** Distance from the bottom of the screen (clear of the page number below the page); the safe area by default. */
  bottom?: number;
  wpm: number;
  running: boolean;
  /** How long the current page stays; `n` changes for each page. */
  pageTimer?: { ms: number; n: number } | null;
  onSlower(): void;
  onFaster(): void;
  onToggle(): void;
  onStop(): void;
}

export function AutoBar({ theme, bottom, wpm, running, pageTimer, onSlower, onFaster, onToggle, onStop }: Props) {
  const insets = useSafeAreaInsets();
  const fill = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!pageTimer) return;
    fill.setValue(0);
    const anim = Animated.timing(fill, { toValue: 1, duration: pageTimer.ms, easing: Easing.linear, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [pageTimer?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const btn = (icon: keyof typeof Ionicons.glyphMap, label: string, onPress: () => void, size = 22) => (
    <Tap onPress={onPress} hitSlop={8} accessibilityLabel={label} style={styles.btn}>
      <Ionicons name={icon} size={size} color={theme.text} />
    </Tap>
  );
  return (
    <View style={[styles.bar, { bottom: bottom ?? insets.bottom + 12, backgroundColor: theme.chrome, borderColor: theme.border }, running && styles.quiet]}>
      {btn('remove', 'Slower', onSlower)}
      <Text style={[styles.speed, { color: theme.text }]} accessibilityLabel={`${wpm} words per minute`}>
        {wpm} wpm
      </Text>
      {btn('add', 'Faster', onFaster)}
      {btn(running ? 'pause' : 'play', running ? 'Pause' : 'Resume', onToggle, 24)}
      {btn('close', 'Stop', onStop)}
      {pageTimer ? (
        <View style={[styles.track, { backgroundColor: theme.border }]} testID="auto-page-timer">
          <Animated.View style={[styles.fill, { backgroundColor: theme.accent, transform: [{ scaleX: fill }] }]} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  // Out of the way while it runs, without disappearing.
  quiet: { opacity: 0.75 },
  btn: { padding: 6 },
  speed: { fontSize: 14, fontWeight: '600', minWidth: 70, textAlign: 'center' },
  track: { position: 'absolute', left: 22, right: 22, bottom: 3, height: 2, borderRadius: 1, overflow: 'hidden' },
  fill: { height: 2, transformOrigin: 'left' },
});
