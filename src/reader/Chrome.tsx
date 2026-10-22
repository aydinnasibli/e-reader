// Bars shown over the page when you tap the middle of the screen.

import Slider from '@react-native-community/slider';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Theme } from '@/lib/settings';

interface Props {
  theme: Theme;
  title: string;
  chapter?: string;
  fraction: number;
  preparing?: number;
  onBack(): void;
  onContents(): void;
  onSettings(): void;
  onSeek(fraction: number): void;
}

export function Chrome({ theme, title, chapter, fraction, preparing, onBack, onContents, onSettings, onSeek }: Props) {
  const insets = useSafeAreaInsets();
  const [drag, setDrag] = useState<number | null>(null);
  useEffect(() => setDrag(null), [fraction]);
  const shown = drag ?? fraction;
  const bar = { backgroundColor: theme.chrome, borderColor: theme.border };

  return (
    <>
      <View style={[styles.top, bar, { paddingTop: insets.top }]}>
        <Pressable onPress={onBack} hitSlop={10} style={styles.btn}>
          <Text style={[styles.btnText, { color: theme.accent }]}>‹ Library</Text>
        </Pressable>
        <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
          {title}
        </Text>
        <Pressable onPress={onContents} hitSlop={10} style={styles.btn}>
          <Text style={[styles.btnText, { color: theme.accent }]}>Contents</Text>
        </Pressable>
        <Pressable onPress={onSettings} hitSlop={10} style={styles.btn}>
          <Text style={[styles.btnText, { color: theme.accent, fontWeight: '700' }]}>Aa</Text>
        </Pressable>
      </View>
      <View style={[styles.bottom, bar, { paddingBottom: insets.bottom + 8 }]}>
        <Text numberOfLines={1} style={[styles.small, { color: theme.muted }]}>
          {chapter ?? ' '}
        </Text>
        <Slider
          style={styles.slider}
          minimumValue={0}
          maximumValue={1}
          value={fraction}
          onValueChange={setDrag}
          onSlidingComplete={(v) => onSeek(v)}
          minimumTrackTintColor={theme.accent}
          maximumTrackTintColor={theme.border}
          thumbTintColor={theme.accent}
        />
        <Text style={[styles.small, { color: theme.muted }]}>
          {(shown * 100).toFixed(1)}%{preparing !== undefined ? ` · preparing book ${Math.round(preparing * 100)}%` : ''}
        </Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  top: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 10,
    gap: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 10,
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  btn: { paddingVertical: 6 },
  btnText: { fontSize: 16 },
  title: { flex: 1, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  small: { fontSize: 12 },
  slider: { alignSelf: 'stretch', height: 36 },
});
