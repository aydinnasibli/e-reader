// The bars shown over the page when you tap the middle of the screen.

import Ionicons from '@expo/vector-icons/Ionicons';
import Slider from '@react-native-community/slider';
import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Theme } from '@/lib/settings';
import { Tap } from '@/ui/Tap';

/** The tool labels share one row: they grow with the phone's text size only this far. */
const LABEL_SCALE = 1.3;
/** The least a button is to the finger, both ways (its own size: a hit area past its row isn't touched on Android). */
const TARGET = 44;

interface Props {
  visible: boolean;
  theme: Theme;
  title: string;
  chapter?: string;
  /** The chapter at a slider position being dragged to. */
  chapterAt?(fraction: number): string | undefined;
  fraction: number;
  /** e.g. "2 h 10 min left in book" */
  info?: string;
  /** The same, for a slider position being dragged to. */
  infoAt?(fraction: number): string | undefined;
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
    <Tap onPress={onPress} hitSlop={6} style={styles.tool} accessibilityLabel={label}>
      <Ionicons name={name} size={24} color={color} />
      <Text numberOfLines={1} maxFontSizeMultiplier={LABEL_SCALE} style={[styles.toolLabel, { color }]}>
        {label}
      </Text>
    </Tap>
  );
  const chapterButton = (dir: 'prev' | 'next', onPress?: () => void) => (
    <Tap
      onPress={onPress}
      disabled={!onPress}
      style={[styles.chapterBtn, { opacity: onPress ? 1 : 0.3 }]}
      accessibilityLabel={dir === 'prev' ? 'Previous chapter' : 'Next chapter'}>
      <Ionicons name={dir === 'prev' ? 'play-skip-back-outline' : 'play-skip-forward-outline'} size={20} color={theme.text} />
    </Tap>
  );
  // Clear of a landscape notch or camera cutout on either side.
  const sides = (pad: number) => ({ paddingLeft: pad + insets.left, paddingRight: pad + insets.right });

  return (
    <>
      <Animated.View
        pointerEvents={p.visible ? 'auto' : 'none'}
        style={[styles.top, bar, sides(8), { paddingTop: insets.top + 4, opacity: fade, transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }] }]}>
        <Tap onPress={p.onBack} hitSlop={8} style={styles.back} accessibilityLabel="Back to library">
          <Ionicons name="chevron-back" size={24} color={theme.text} />
        </Tap>
        <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
          {p.title}
        </Text>
        <Tap onPress={p.onAuto} hitSlop={8} style={styles.back} accessibilityLabel={p.autoLabel}>
          <Ionicons name="play-circle-outline" size={26} color={theme.text} />
        </Tap>
      </Animated.View>
      <Animated.View
        pointerEvents={p.visible ? 'auto' : 'none'}
        style={[styles.bottom, bar, sides(18), { paddingBottom: insets.bottom + 8, opacity: fade, transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }]}>
        <View style={styles.chapterRow}>
          {chapterButton('prev', p.onPrevChapter)}
          <Text numberOfLines={1} style={[styles.chapter, { color: theme.text }]}>
            {(drag !== null && p.chapterAt ? p.chapterAt(drag) : p.chapter) ?? ' '}
          </Text>
          {chapterButton('next', p.onNextChapter)}
        </View>
        <Slider
          testID="progress-slider"
          style={styles.slider}
          minimumValue={0}
          maximumValue={1}
          value={p.fraction}
          onValueChange={setDrag}
          onSlidingComplete={(v) => p.onSeek(v)}
          tapToSeek
          minimumTrackTintColor={theme.accent}
          maximumTrackTintColor={theme.border}
          // The iPhone's own white knob is bigger and easier to see than a coloured one.
          thumbTintColor={Platform.OS === 'android' ? theme.accent : undefined}
        />
        <View style={styles.infoRow}>
          {/* Where you are, as a button: tap to type a page to go to. The pill is drawn in a full-height target. */}
          <Tap onPress={p.onGoTo} accessibilityRole="button" accessibilityLabel="Go to page" style={styles.goToTarget}>
            <View style={[styles.goTo, { borderColor: theme.accent }]}>
              <Ionicons name="keypad-outline" size={14} color={theme.accent} />
              <Text numberOfLines={1} maxFontSizeMultiplier={LABEL_SCALE} style={[styles.small, styles.goToText, { color: theme.text }]}>
                {p.pageLabel ? `${p.pageLabel(shown)} · ` : ''}
                {(shown * 100).toFixed(1)}%
              </Text>
            </View>
          </Tap>
          {/* Beside it on two lines where it fits, else on a line of its own: never cut short. */}
          <Text numberOfLines={2} maxFontSizeMultiplier={LABEL_SCALE} style={[styles.small, styles.info, { color: theme.muted }]}>
            {(drag !== null && p.infoAt ? p.infoAt(drag) : p.info) ?? ''}
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
    // (The chapter row's buttons are full-size targets: the title sits where it did with 12.)
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  back: { padding: 8, width: 40 },
  title: { flex: 1, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  tools: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 2, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  tool: { alignItems: 'center', minWidth: 58, paddingVertical: 2 },
  toolLabel: { fontSize: 11, marginTop: 3 },
  chapterRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chapterBtn: { width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center' },
  chapter: { flex: 1, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  goToTarget: { minHeight: TARGET, justifyContent: 'center' },
  goTo: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  goToText: { fontWeight: '600' },
  slider: { alignSelf: 'stretch', height: 40 },
  infoRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', columnGap: 12 },
  small: { fontSize: 12 },
  // Two lines of about 25 characters beside the page pill; less room than that, and it goes under it.
  info: { flexGrow: 1, flexShrink: 1, flexBasis: 150, textAlign: 'right' },
});
