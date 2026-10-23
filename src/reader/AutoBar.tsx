// Control for auto page turn / auto-scroll: speed, pause/resume, stop.

import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Theme } from '@/lib/settings';

interface Props {
  theme: Theme;
  wpm: number;
  running: boolean;
  onSlower(): void;
  onFaster(): void;
  onToggle(): void;
  onStop(): void;
}

export function AutoBar({ theme, wpm, running, onSlower, onFaster, onToggle, onStop }: Props) {
  const insets = useSafeAreaInsets();
  const btn = (icon: keyof typeof Ionicons.glyphMap, label: string, onPress: () => void, size = 22) => (
    <Pressable onPress={onPress} hitSlop={8} accessibilityLabel={label} style={({ pressed }) => [styles.btn, pressed && { opacity: 0.5 }]}>
      <Ionicons name={icon} size={size} color={theme.text} />
    </Pressable>
  );
  return (
    <View style={[styles.bar, { bottom: insets.bottom + 12, backgroundColor: theme.chrome, borderColor: theme.border }, running && styles.quiet]}>
      {btn('remove', 'Slower', onSlower)}
      <Text style={[styles.speed, { color: theme.text }]} accessibilityLabel={`${wpm} words per minute`}>
        {wpm} wpm
      </Text>
      {btn('add', 'Faster', onFaster)}
      {btn(running ? 'pause' : 'play', running ? 'Pause' : 'Resume', onToggle, 24)}
      {btn('close', 'Stop', onStop)}
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
});
