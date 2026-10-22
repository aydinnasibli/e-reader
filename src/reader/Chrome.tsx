// The bars shown over the page when you tap the middle of the screen.

import Ionicons from '@expo/vector-icons/Ionicons';
import Slider from '@react-native-community/slider';
import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Theme } from '@/lib/settings';

interface Props {
  visible: boolean;
  theme: Theme;
  title: string;
  chapter?: string;
  fraction: number;
  /** e.g. "2 h 10 min left in book" */
  info?: string;
  bookmarked: boolean;
  onBack(): void;
  onSearch(): void;
  onBookmark(): void;
  onContents(): void;
  onSettings(): void;
  onSeek(fraction: number): void;
}

export function Chrome(p: Props) {
  const { theme } = p;
  const insets = useSafeAreaInsets();
  const [drag, setDrag] = useState<number | null>(null);
  const [mounted, setMounted] = useState(p.visible);
  const fade = useRef(new Animated.Value(p.visible ? 1 : 0)).current;

  useEffect(() => setDrag(null), [p.fraction]);
  useEffect(() => {
    if (p.visible) setMounted(true);
    Animated.timing(fade, { toValue: p.visible ? 1 : 0, duration: 160, useNativeDriver: true }).start(({ finished }) => {
      if (finished && !p.visible) setMounted(false);
    });
  }, [p.visible, fade]);

  if (!mounted) return null;
  const shown = drag ?? p.fraction;
  const bar = { backgroundColor: theme.chrome, borderColor: theme.border };
  const icon = (name: keyof typeof Ionicons.glyphMap, onPress: () => void, label: string, color = theme.text) => (
    <Pressable onPress={onPress} hitSlop={8} style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.5 }]} accessibilityLabel={label}>
      <Ionicons name={name} size={23} color={color} />
    </Pressable>
  );

  return (
    <>
      <Animated.View
        pointerEvents={p.visible ? 'auto' : 'none'}
        style={[styles.top, bar, { paddingTop: insets.top + 4, opacity: fade, transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }] }]}>
        {icon('chevron-back', p.onBack, 'Back to library')}
        <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
          {p.title}
        </Text>
        {icon('search', p.onSearch, 'Search in book')}
        {icon(p.bookmarked ? 'bookmark' : 'bookmark-outline', p.onBookmark, p.bookmarked ? 'Remove bookmark' : 'Add bookmark', p.bookmarked ? theme.accent : theme.text)}
        {icon('list', p.onContents, 'Contents, bookmarks and highlights')}
        {icon('text', p.onSettings, 'Text settings')}
      </Animated.View>
      <Animated.View
        pointerEvents={p.visible ? 'auto' : 'none'}
        style={[styles.bottom, bar, { paddingBottom: insets.bottom + 8, opacity: fade, transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }]}>
        <Text numberOfLines={1} style={[styles.chapter, { color: theme.text }]}>
          {p.chapter ?? ' '}
        </Text>
        <Slider
          style={styles.slider}
          minimumValue={0}
          maximumValue={1}
          value={p.fraction}
          onValueChange={setDrag}
          onSlidingComplete={(v) => p.onSeek(v)}
          minimumTrackTintColor={theme.accent}
          maximumTrackTintColor={theme.border}
          thumbTintColor={theme.accent}
        />
        <View style={styles.infoRow}>
          <Text style={[styles.small, { color: theme.muted }]}>{(shown * 100).toFixed(1)}%</Text>
          <Text style={[styles.small, { color: theme.muted }]}>{p.info ?? ''}</Text>
        </View>
      </Animated.View>
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
    paddingHorizontal: 8,
    paddingBottom: 8,
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 18,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  iconBtn: { padding: 8 },
  title: { flex: 1, fontSize: 15, fontWeight: '600', marginHorizontal: 4 },
  chapter: { fontSize: 14, fontWeight: '600', textAlign: 'center' },
  slider: { alignSelf: 'stretch', height: 40 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between' },
  small: { fontSize: 12 },
});
