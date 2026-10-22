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
  onDisplay(): void;
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
  const tool = (name: keyof typeof Ionicons.glyphMap, onPress: () => void, label: string, color = theme.text) => (
    <Pressable onPress={onPress} hitSlop={6} style={({ pressed }) => [styles.tool, pressed && { opacity: 0.5 }]} accessibilityLabel={label}>
      <Ionicons name={name} size={24} color={color} />
      <Text style={[styles.toolLabel, { color }]}>{label}</Text>
    </Pressable>
  );

  return (
    <>
      <Animated.View
        pointerEvents={p.visible ? 'auto' : 'none'}
        style={[styles.top, bar, { paddingTop: insets.top + 4, opacity: fade, transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }] }]}>
        <Pressable onPress={p.onBack} hitSlop={8} style={styles.back} accessibilityLabel="Back to library">
          <Ionicons name="chevron-back" size={24} color={theme.text} />
        </Pressable>
        <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
          {p.title}
        </Text>
        <View style={styles.back} />
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
        <View style={[styles.tools, { borderColor: theme.border }]}>
          {tool('list', p.onContents, 'Contents')}
          {tool('search', p.onSearch, 'Search')}
          {tool(p.bookmarked ? 'bookmark' : 'bookmark-outline', p.onBookmark, 'Bookmark', p.bookmarked ? theme.accent : theme.text)}
          {tool('text', p.onDisplay, 'Display')}
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
  back: { padding: 8, width: 40 },
  title: { flex: 1, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  tools: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  tool: { alignItems: 'center', minWidth: 64, paddingVertical: 2 },
  toolLabel: { fontSize: 11, marginTop: 3 },
  chapter: { fontSize: 14, fontWeight: '600', textAlign: 'center' },
  slider: { alignSelf: 'stretch', height: 40 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between' },
  small: { fontSize: 12 },
});
