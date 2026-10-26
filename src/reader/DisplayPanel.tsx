// The "Display" panel: slides up over the bottom of the page and changes
// reading settings live. Settings are global and saved immediately. While a
// slider is dragged the reader shows the text redrawn with each value
// (onSlide); the value is saved, and pages laid out, when it is released.

import Ionicons from '@expo/vector-icons/Ionicons';
import Slider from '@react-native-community/slider';
import * as Font from 'expo-font';
import * as Haptics from 'expo-haptics';
import { type ReactNode, createContext, useContext, useEffect, useRef, useState } from 'react';
import { Animated, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FONTS, type FontDef, fontFace, isFontLoaded } from '@/lib/fonts';
import {
  BG_SWATCHES,
  FONT_SIZE,
  LETTER_SPACING,
  LINE_SPACING,
  MARGIN,
  PARA_SPACING,
  type ReaderSettings,
  TEXT_SWATCHES,
  THEMES,
  type Theme,
  type ThemeName,
  customTheme,
  resetSettings,
  setSettings,
} from '@/lib/settings';
import { Segmented } from '@/ui/Segmented';
import { Tap } from '@/ui/Tap';

type Tab = 'text' | 'spacing' | 'colors' | 'page';
const TABS: { key: Tab; label: string }[] = [
  { key: 'text', label: 'Text' },
  { key: 'spacing', label: 'Spacing' },
  { key: 'colors', label: 'Colours' },
  { key: 'page', label: 'Page' },
];

/**
 * The "Aa" of each font in the panel needs only the font's regular face:
 * loading every face of every font for it would be many megabytes. A font
 * read with is loaded whole (fonts.ts) and shown with that.
 */
const previewFamily = (id: string) => `${id}-preview`;
function loadPreview(def: FontDef): Promise<void> {
  if (!def.files || isFontLoaded(def.id) || Font.isLoaded(previewFamily(def.id))) return Promise.resolve();
  return Font.loadAsync({ [previewFamily(def.id)]: def.files.regular });
}
function previewFace(id: string) {
  return !isFontLoaded(id) && Font.isLoaded(previewFamily(id)) ? { fontFamily: previewFamily(id) } : fontFace(id, 'regular', false, false);
}

/** A slider being dragged stops the panel scrolling, which would otherwise take the gesture. */
const Sliding = createContext<(active: boolean) => void>(() => {});

/** A slider moved (`done` false) or was released (`done` true). */
export type SlideHandler = (patch: Partial<ReaderSettings>, done: boolean) => void;

interface Props {
  visible: boolean;
  onClose(): void;
  settings: ReaderSettings;
  theme: Theme;
  onSlide: SlideHandler;
}

export function DisplayPanel({ visible, onClose, settings, theme, onSlide }: Props) {
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const height = Math.min(460, Math.round(win.height * 0.5)) + insets.bottom;
  const slide = useRef(new Animated.Value(visible ? 0 : 1)).current;
  const [mounted, setMounted] = useState(visible);
  const [tab, setTab] = useState<Tab>('text');
  const [sliding, setSliding] = useState(false);

  useEffect(() => {
    if (visible) setMounted(true);
    Animated.timing(slide, { toValue: visible ? 0 : 1, duration: 220, useNativeDriver: true }).start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
  }, [visible, slide]);

  // Preview fonts need their files; load them when the panel opens.
  const [, setFontsTick] = useState(0);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    for (const f of FONTS) loadPreview(f).then(() => alive && setFontsTick((t) => t + 1), () => {});
    return () => {
      alive = false;
    };
  }, [visible]);

  if (!mounted) return null;
  const c = theme;

  return (
    <>
      {/* Tapping the page above closes the panel. */}
      <Pressable style={[StyleSheet.absoluteFill, { bottom: height }]} onPress={onClose} accessibilityLabel="Close display settings" />
      <Animated.View
        style={[
          styles.panel,
          {
            height,
            paddingBottom: insets.bottom,
            // Clear of the notch on a phone turned on its side.
            paddingLeft: insets.left,
            paddingRight: insets.right,
            backgroundColor: c.chrome,
            borderColor: c.border,
            transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [0, height] }) }],
          },
        ]}>
        <View style={styles.header}>
          <Segmented<Tab>
            fill
            style={styles.tabs}
            track={c.bg}
            thumb={c.chrome}
            value={tab}
            options={TABS.map((t) => t.key)}
            render={(k, on) => <Text style={{ color: c.text, fontSize: 14, fontWeight: on ? '700' : '500' }}>{TABS.find((t) => t.key === k)!.label}</Text>}
            onPick={setTab}
          />
          <Tap onPress={onClose} hitSlop={10} accessibilityLabel="Close" style={[styles.close, { backgroundColor: c.bg }]}>
            <Ionicons name="chevron-down" size={20} color={c.text} />
          </Tap>
        </View>
        <Sliding.Provider value={setSliding}>
          <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false} scrollEnabled={!sliding}>
            {tab === 'text' && <TextTab s={settings} c={c} slide={onSlide} />}
            {tab === 'spacing' && <SpacingTab s={settings} c={c} slide={onSlide} />}
            {tab === 'colors' && <ColorsTab s={settings} c={c} />}
            {tab === 'page' && <PageTab s={settings} c={c} />}
          </ScrollView>
        </Sliding.Provider>
      </Animated.View>
    </>
  );
}

// ---------- tabs ----------

function TextTab({ s, c, slide }: { s: ReaderSettings; c: Theme; slide: SlideHandler }) {
  return (
    <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.fonts}>
        {FONTS.map((f) => {
          const active = s.font === f.id;
          return (
            <Tap
              key={f.id}
              haptic="select"
              accessibilityState={{ selected: active }}
              // The page loads the font itself: no waiting for the phone's own copy.
              onPress={() => setSettings({ font: f.id })}
              style={[styles.fontCard, { backgroundColor: c.bg, borderColor: active ? c.accent : c.border }]}>
              <Text style={[previewFace(f.id), { color: c.text, fontSize: 26 }]}>Aa</Text>
              <Text numberOfLines={1} style={[previewFace(f.id), { color: c.text, fontSize: 13 }]}>
                {f.label}
              </Text>
              {f.note ? <Text style={{ color: c.muted, fontSize: 10 }}>{f.note}</Text> : null}
            </Tap>
          );
        })}
      </ScrollView>
      <SliderRow
        c={c}
        label="Size"
        value={s.fontSize}
        min={FONT_SIZE.min}
        max={FONT_SIZE.max}
        step={1}
        format={(v) => `${v}`}
        left={<Text style={{ color: c.text, fontSize: 14 }}>A</Text>}
        right={<Text style={{ color: c.text, fontSize: 24 }}>A</Text>}
        onChange={(fontSize, done) => slide({ fontSize }, done)}
      />
      <Row c={c} label="Weight">
        <Segment c={c} value={s.weight} options={['regular', 'medium'] as const} render={(w) => (w === 'regular' ? 'Regular' : 'Bolder')} onPick={(weight) => setSettings({ weight })} />
      </Row>
      <Row c={c} label="Alignment">
        <IconSegment
          c={c}
          value={s.align}
          options={[
            { v: 'left', icon: 'reorder-four-outline', label: 'Left' },
            { v: 'justify', icon: 'menu-outline', label: 'Justified' },
          ]}
          onPick={(align) => setSettings({ align })}
        />
      </Row>
      <Row c={c} label="Indent paragraphs">
        <Toggle c={c} value={s.indent} onChange={(indent) => setSettings({ indent })} />
      </Row>
      <Row c={c} label="Hyphenation">
        <Toggle c={c} value={s.hyphenate} onChange={(hyphenate) => setSettings({ hyphenate })} />
      </Row>
    </>
  );
}

function SpacingTab({ s, c, slide }: { s: ReaderSettings; c: Theme; slide: SlideHandler }) {
  return (
    <>
      <SliderRow c={c} label="Line spacing" value={s.lineSpacing} min={LINE_SPACING.min} max={LINE_SPACING.max} step={0.05} format={(v) => v.toFixed(2)} onChange={(lineSpacing, done) => slide({ lineSpacing }, done)} />
      <SliderRow c={c} label="Letter spacing" value={s.letterSpacing} min={LETTER_SPACING.min} max={LETTER_SPACING.max} step={0.1} format={(v) => v.toFixed(1)} onChange={(letterSpacing, done) => slide({ letterSpacing }, done)} />
      <SliderRow c={c} label="Paragraph spacing" value={s.paraSpacing} min={PARA_SPACING.min} max={PARA_SPACING.max} step={0.05} format={(v) => `${v.toFixed(2)} lines`} onChange={(paraSpacing, done) => slide({ paraSpacing }, done)} />
      <SliderRow c={c} label="Margins" value={s.margin} min={MARGIN.min} max={MARGIN.max} step={2} format={(v) => `${v}`} onChange={(margin, done) => slide({ margin }, done)} />
      <Tap onPress={resetSettings} haptic="light" style={[styles.reset, { borderColor: c.border, backgroundColor: c.bg }]}>
        <Text style={{ color: c.text, fontSize: 15, fontWeight: '500' }}>Reset text and spacing</Text>
      </Tap>
    </>
  );
}

const PRESETS = Object.keys(THEMES) as Exclude<ThemeName, 'custom'>[];

function ColorsTab({ s, c }: { s: ReaderSettings; c: Theme }) {
  const swatch = (name: ThemeName, t: Theme, label: string) => (
    <Tap
      key={name}
      haptic="select"
      accessibilityLabel={`${label} theme`}
      accessibilityState={{ selected: s.theme === name }}
      onPress={() => setSettings({ theme: name })}
      style={[styles.themeSwatch, { backgroundColor: t.bg, borderColor: s.theme === name ? c.accent : c.border }]}>
      <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Aa</Text>
      <Text style={{ color: t.muted, fontSize: 10, marginTop: 2 }}>{label}</Text>
    </Tap>
  );
  return (
    <>
      <View style={styles.themeGrid}>
        {PRESETS.map((n) => swatch(n, THEMES[n], n[0].toUpperCase() + n.slice(1)))}
        {swatch('custom', customTheme(s.customBg, s.customText), 'Custom')}
      </View>
      <Text style={[styles.section, { color: c.muted }]}>CUSTOM BACKGROUND</Text>
      <Swatches c={c} colors={BG_SWATCHES} value={s.theme === 'custom' ? s.customBg : ''} onPick={(customBg) => setSettings({ customBg, theme: 'custom' })} />
      <Text style={[styles.section, { color: c.muted }]}>CUSTOM TEXT</Text>
      <Swatches c={c} colors={TEXT_SWATCHES} value={s.theme === 'custom' ? s.customText : ''} onPick={(customText) => setSettings({ customText, theme: 'custom' })} />
      <Row c={c} label="Dark theme when phone is in dark mode">
        <Toggle c={c} value={s.autoNight} onChange={(autoNight) => setSettings({ autoNight })} />
      </Row>
      {s.autoNight && (
        <Row c={c} label="Night theme">
          <Segment
            c={c}
            value={s.nightTheme}
            options={['night', 'gray', 'dark', 'black'] as const}
            render={(n) => n[0].toUpperCase() + n.slice(1)}
            onPick={(nightTheme) => setSettings({ nightTheme })}
          />
        </Row>
      )}
    </>
  );
}

function PageTab({ s, c }: { s: ReaderSettings; c: Theme }) {
  return (
    <>
      <Row c={c} label="Reading mode">
        <Segment c={c} value={s.mode} options={['page', 'scroll'] as const} render={(m) => (m === 'page' ? 'Pages' : 'Scroll')} onPick={(mode) => setSettings({ mode })} />
      </Row>
      <Row c={c} label="Page turn">
        <Segment
          c={c}
          value={s.pageTurn}
          options={['slide', 'fade', 'none'] as const}
          render={(t) => (t === 'slide' ? 'Slide' : t === 'fade' ? 'Fade' : 'Instant')}
          onPick={(pageTurn) => setSettings({ pageTurn })}
        />
      </Row>
      <Row c={c} label="Rotation">
        <Segment
          c={c}
          value={s.rotation}
          options={['auto', 'portrait', 'landscape'] as const}
          render={(r) => (r === 'auto' ? 'Auto' : r === 'portrait' ? 'Portrait' : 'Landscape')}
          onPick={(rotation) => setSettings({ rotation })}
        />
      </Row>
      <View style={styles.stack}>
        <Text style={[styles.label, { color: c.text }]}>Keep the screen on</Text>
        <Segment
          c={c}
          value={s.screenAwake}
          options={['system', '2', '5', '10', 'always'] as const}
          render={(v) => (v === 'system' ? 'Phone' : v === 'always' ? 'Always' : `${v} min`)}
          onPick={(screenAwake) => setSettings({ screenAwake })}
        />
        <Text style={[styles.hint, { color: c.muted }]}>
          {s.screenAwake === 'system'
            ? 'The screen turns off after the phone’s usual time.'
            : s.screenAwake === 'always'
              ? 'The screen stays on while a book is open.'
              : `The screen stays on while you read, and turns off ${s.screenAwake} minutes after the last page turn.`}
        </Text>
      </View>
      <Row c={c} label="Time and battery while reading">
        <Toggle c={c} value={s.showClock} onChange={(showClock) => setSettings({ showClock })} />
      </Row>
      <Row c={c} label="Tap left side to go forward">
        <Toggle c={c} value={s.tapForward} onChange={(tapForward) => setSettings({ tapForward })} />
      </Row>
      <Text style={[styles.hint, { color: c.muted }]}>
        Tap the right side of a page (or swipe) to turn it. With the switch on, both sides go forward — handy for one-handed reading; swipe right to go back.
      </Text>
    </>
  );
}

// ---------- controls ----------

function Row({ c, label, children }: { c: Theme; label: string; children: ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { color: c.text }]}>{label}</Text>
      {children}
    </View>
  );
}

function Segment<T extends string>({ c, value, options, render, onPick }: { c: Theme; value: T; options: readonly T[]; render(v: T): string; onPick(v: T): void }) {
  return (
    <Segmented
      track={c.bg}
      thumb={c.accent}
      value={value}
      options={options}
      itemStyle={styles.segItem}
      render={(o, on) => <Text style={{ color: on ? '#fff' : c.text, fontSize: 14, fontWeight: on ? '600' : '500' }}>{render(o)}</Text>}
      onPick={onPick}
    />
  );
}

function IconSegment<T extends string>({
  c,
  value,
  options,
  onPick,
}: {
  c: Theme;
  value: T;
  options: { v: T; icon: keyof typeof Ionicons.glyphMap; label: string }[];
  onPick(v: T): void;
}) {
  const byValue = (v: T) => options.find((o) => o.v === v)!;
  return (
    <Segmented
      track={c.bg}
      thumb={c.accent}
      value={value}
      options={options.map((o) => o.v)}
      itemStyle={styles.segIcon}
      label={(v) => byValue(v).label}
      render={(v, on) => <Ionicons name={byValue(v).icon} size={20} color={on ? '#fff' : c.text} />}
      onPick={onPick}
    />
  );
}

function Toggle({ c, value, onChange }: { c: Theme; value: boolean; onChange(v: boolean): void }) {
  return (
    <Switch
      value={value}
      onValueChange={(v) => {
        Haptics.selectionAsync().catch(() => {});
        onChange(v);
      }}
      trackColor={{ true: c.accent, false: c.border }}
      ios_backgroundColor={c.border}
      thumbColor={Platform.OS === 'android' ? (value ? '#fff' : '#f4f4f4') : undefined}
    />
  );
}

function Swatches({ c, colors, value, onPick }: { c: Theme; colors: string[]; value: string; onPick(v: string): void }) {
  return (
    <View style={styles.swatches}>
      {colors.map((col) => {
        const on = value.toLowerCase() === col.toLowerCase();
        return (
          <Tap
            key={col}
            haptic="select"
            onPress={() => onPick(col)}
            accessibilityLabel={col}
            accessibilityState={{ selected: on }}
            style={[styles.colorDot, { backgroundColor: col, borderColor: on ? c.accent : c.border, borderWidth: on ? 3 : 2 }]}
          />
        );
      })}
    </View>
  );
}

/** Slider that shows its value live and applies it when released (re-laying out a book on every pixel would be wasteful). */
function SliderRow({
  c,
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  left,
  right,
}: {
  c: Theme;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format(v: number): string;
  onChange(v: number, done: boolean): void;
  left?: ReactNode;
  right?: ReactNode;
}) {
  const [live, setLive] = useState<number | null>(null);
  const setSliding = useContext(Sliding);
  const shown = live ?? value;
  const snap = (v: number) => Math.round(Math.round(v / step) * step * 1000) / 1000;
  return (
    <View style={styles.sliderBlock}>
      <View style={styles.sliderHead}>
        <Text style={[styles.label, { color: c.text }]}>{label}</Text>
        <Text style={{ color: live === null ? c.muted : c.accent, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{format(shown)}</Text>
      </View>
      <View style={styles.sliderRow}>
        {left}
        <Slider
          testID={`slider-${label}`}
          style={styles.slider}
          // Tap anywhere on the bar to jump there, not only on the knob (iPhone).
          tapToSeek
          minimumValue={min}
          maximumValue={max}
          step={step}
          value={value}
          onValueChange={(v) => {
            const n = snap(v);
            // Sliders report every pixel; only pass on real changes.
            if (n === (live ?? value)) return;
            Haptics.selectionAsync().catch(() => {});
            setLive(n);
            onChange(n, false);
          }}
          onSlidingStart={() => setSliding(true)}
          onSlidingComplete={(v) => {
            setSliding(false);
            setLive(null);
            onChange(snap(v), true);
          }}
          minimumTrackTintColor={c.accent}
          maximumTrackTintColor={c.border}
          // The iPhone's own white knob, with its shadow, is bigger and easier to see than a coloured one.
          thumbTintColor={Platform.OS === 'android' ? c.accent : undefined}
        />
        {right}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -2 },
    elevation: 12,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6 },
  tabs: { flex: 1 },
  close: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  body: { paddingHorizontal: 18, paddingBottom: 18 },
  fonts: { gap: 10, paddingVertical: 10 },
  fontCard: { width: 112, minHeight: 82, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 50, gap: 12 },
  stack: { paddingVertical: 8, gap: 8, alignItems: 'flex-start' },
  label: { fontSize: 16, fontWeight: '500', flexShrink: 1 },
  segItem: { paddingHorizontal: 11, paddingVertical: 7 },
  segIcon: { paddingHorizontal: 15, paddingVertical: 6 },
  slider: { flex: 1, height: 48 },
  sliderBlock: { paddingTop: 10 },
  sliderHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  reset: { alignSelf: 'center', marginTop: 18, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 9 },
  themeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingVertical: 10 },
  themeSwatch: { width: 60, minHeight: 56, paddingVertical: 4, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  section: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6, marginTop: 12, marginBottom: 8 },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  colorDot: { width: 34, height: 34, borderRadius: 17, borderWidth: 2 },
  hint: { fontSize: 13, lineHeight: 18, marginTop: 6 },
});
