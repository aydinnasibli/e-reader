// The bars shown over the page when you tap the middle of the screen.

import Ionicons from '@expo/vector-icons/Ionicons';
import Slider from '@react-native-community/slider';
import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Theme } from '@/lib/settings';

/** The tool labels share one row: they grow with the phone's text size only this far. */
const LABEL_SCALE = 1.3;

interface Props {
  visible: boolean;
  theme: Theme;
  title: string;
  chapter?: string;
  fraction: number;
  /** e.g. "2 h 10 min left in book" */
  info?: string;
  /** "Page 412 of 830" for a slider position, in page mode. */
  pageLabel?(fraction: number): string;
  bookmarked: boolean;
  onBack(): void;
  /** Start auto page turn (page mode) or auto-scroll (scroll mode). */
  onAuto(): void;
  autoLabel: string;
  onSearch(): void;
  onBookmark(): void;
  onContents(): void;
  onDisplay(): void;
  onHighlight(): void;
  onSeek(fraction: number): void;
  /** Type a page number or percentage to go to. */
  onGoTo(): void;
  /** Previous / next chapter; missing when there is none that way. */
  onPrevChapter?(): void;
  onNextChapter?(): void;
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
      <Text numberOfLines={1} maxFontSizeMultiplier={LABEL_SCALE} style={[styles.toolLabel, { color }]}>
        {label}
      </Text>
    </Pressable>
  );
  const chapterButton = (dir: 'prev' | 'next', onPress?: () => void) => (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      hitSlop={10}
      style={({ pressed }) => [styles.chapterBtn, { opacity: !onPress ? 0.3 : pressed ? 0.5 : 1 }]}
      accessibilityLabel={dir === 'prev' ? 'Previous chapter' : 'Next chapter'}>
      <Ionicons name={dir === 'prev' ? 'play-skip-back-outline' : 'play-skip-forward-outline'} size={20} color={theme.text} />
    </Pressable>
  );
  // Clear of a landscape notch or camera cutout on either side.
  const sides = (pad: number) => ({ paddingLeft: pad + insets.left, paddingRight: pad + insets.right });

  return (
    <>
      <Animated.View
        pointerEvents={p.visible ? 'auto' : 'none'}
        style={[styles.top, bar, sides(8), { paddingTop: insets.top + 4, opacity: fade, transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }] }]}>
        <Pressable onPress={p.onBack} hitSlop={8} style={styles.back} accessibilityLabel="Back to library">
          <Ionicons name="chevron-back" size={24} color={theme.text} />
        </Pressable>
        <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
          {p.title}
        </Text>
        <Pressable onPress={p.onAuto} hitSlop={8} style={styles.back} accessibilityLabel={p.autoLabel}>
          <Ionicons name="play-circle-outline" size={26} color={theme.text} />
        </Pressable>
      </Animated.View>
      <Animated.View
        pointerEvents={p.visible ? 'auto' : 'none'}
        style={[styles.bottom, bar, sides(18), { paddingBottom: insets.bottom + 8, opacity: fade, transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }]}>
        <View style={styles.chapterRow}>
          {chapterButton('prev', p.onPrevChapter)}
          <Text numberOfLines={1} style={[styles.chapter, { color: theme.text }]}>
            {p.chapter ?? ' '}
          </Text>
          {chapterButton('next', p.onNextChapter)}
        </View>
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
          {/* Where you are, as a button: tap to type a page to go to. */}
          <Pressable
            onPress={p.onGoTo}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Go to page"
            style={({ pressed }) => [styles.goTo, { borderColor: theme.accent, opacity: pressed ? 0.5 : 1 }]}>
            <Ionicons name="keypad-outline" size={14} color={theme.accent} />
            <Text numberOfLines={1} maxFontSizeMultiplier={LABEL_SCALE} style={[styles.small, styles.goToText, { color: theme.text }]}>
              {p.pageLabel ? `${p.pageLabel(shown)} · ` : ''}
              {(shown * 100).toFixed(1)}%
            </Text>
          </Pressable>
          <Text numberOfLines={1} style={[styles.small, styles.info, { color: theme.muted }]}>
            {p.info ?? ''}
          </Text>
        </View>
        <View style={[styles.tools, { borderColor: theme.border }]}>
          {tool('list', p.onContents, 'Contents')}
          {tool('search', p.onSearch, 'Search')}
          {tool(p.bookmarked ? 'bookmark' : 'bookmark-outline', p.onBookmark, 'Bookmark', p.bookmarked ? theme.accent : theme.text)}
          {tool('brush-outline', p.onHighlight, 'Highlight')}
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
    paddingBottom: 8,
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  back: { padding: 8, width: 40 },
  title: { flex: 1, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  tools: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  tool: { alignItems: 'center', minWidth: 58, paddingVertical: 2 },
  toolLabel: { fontSize: 11, marginTop: 3 },
  chapterRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chapterBtn: { padding: 4 },
  chapter: { flex: 1, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  goTo: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  goToText: { fontWeight: '600' },
  slider: { alignSelf: 'stretch', height: 40 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  small: { fontSize: 12 },
  info: { flexShrink: 1, textAlign: 'right', marginLeft: 12 },
});
