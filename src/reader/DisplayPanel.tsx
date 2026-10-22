// The "Display" panel: slides up over the bottom of the page and changes
// reading settings live. Settings are global and saved immediately.

import Ionicons from '@expo/vector-icons/Ionicons';
import Slider from '@react-native-community/slider';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Switch, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FONTS, ensureFont, fontFace, isFontLoaded } from '@/lib/fonts';
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

type Tab = 'text' | 'spacing' | 'colors' | 'page';
const TABS: { key: Tab; label: string }[] = [
  { key: 'text', label: 'Text' },
  { key: 'spacing', label: 'Spacing' },
  { key: 'colors', label: 'Colours' },
  { key: 'page', label: 'Page' },
];

interface Props {
  visible: boolean;
  onClose(): void;
  settings: ReaderSettings;
  theme: Theme;
}

export function DisplayPanel({ visible, onClose, settings, theme }: Props) {
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const height = Math.min(460, Math.round(win.height * 0.5)) + insets.bottom;
  const slide = useRef(new Animated.Value(visible ? 0 : 1)).current;
  const [mounted, setMounted] = useState(visible);
  const [tab, setTab] = useState<Tab>('text');

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
    for (const f of FONTS) if (!isFontLoaded(f.id)) ensureFont(f.id).then(() => alive && setFontsTick((t) => t + 1), () => {});
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
            backgroundColor: c.chrome,
            borderColor: c.border,
            transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [0, height] }) }],
          },
        ]}>
        <View style={styles.header}>
          <View style={[styles.tabs, { backgroundColor: c.bg }]}>
            {TABS.map((t) => (
              <Pressable key={t.key} onPress={() => setTab(t.key)} style={[styles.tab, tab === t.key && { backgroundColor: c.chrome }]}>
                <Text style={{ color: c.text, fontSize: 14, fontWeight: tab === t.key ? '700' : '500' }}>{t.label}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
            <Ionicons name="chevron-down" size={24} color={c.muted} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          {tab === 'text' && <TextTab s={settings} c={c} />}
          {tab === 'spacing' && <SpacingTab s={settings} c={c} />}
          {tab === 'colors' && <ColorsTab s={settings} c={c} />}
          {tab === 'page' && <PageTab s={settings} c={c} />}
        </ScrollView>
      </Animated.View>
    </>
  );
}

// ---------- tabs ----------

function TextTab({ s, c }: { s: ReaderSettings; c: Theme }) {
  return (
    <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.fonts}>
        {FONTS.map((f) => {
          const active = s.font === f.id;
          return (
            <Pressable
              key={f.id}
              onPress={() => ensureFont(f.id).then(() => setSettings({ font: f.id }), () => setSettings({ font: f.id }))}
              style={[styles.fontCard, { backgroundColor: c.bg, borderColor: active ? c.accent : c.border }]}>
              <Text style={[fontFace(f.id, 'regular', false, false), { color: c.text, fontSize: 26 }]}>Aa</Text>
              <Text numberOfLines={1} style={[fontFace(f.id, 'regular', false, false), { color: c.text, fontSize: 13 }]}>
                {f.label}
              </Text>
              {f.note ? <Text style={{ color: c.muted, fontSize: 10 }}>{f.note}</Text> : null}
            </Pressable>
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
        onDone={(fontSize) => setSettings({ fontSize })}
        preview={(v) => (
          <Text numberOfLines={1} style={[fontFace(s.font, s.weight, false, false), { color: c.text, fontSize: v, textAlign: 'center' }]}>
            The quick fox · Съешь ещё
          </Text>
        )}
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
        <Switch value={s.indent} onValueChange={(indent) => setSettings({ indent })} />
      </Row>
    </>
  );
}

function SpacingTab({ s, c }: { s: ReaderSettings; c: Theme }) {
  return (
    <>
      <SliderRow c={c} label="Line spacing" value={s.lineSpacing} min={LINE_SPACING.min} max={LINE_SPACING.max} step={0.05} format={(v) => v.toFixed(2)} onDone={(lineSpacing) => setSettings({ lineSpacing })} />
      <SliderRow c={c} label="Letter spacing" value={s.letterSpacing} min={LETTER_SPACING.min} max={LETTER_SPACING.max} step={0.1} format={(v) => v.toFixed(1)} onDone={(letterSpacing) => setSettings({ letterSpacing })} />
      <SliderRow c={c} label="Paragraph spacing" value={s.paraSpacing} min={PARA_SPACING.min} max={PARA_SPACING.max} step={0.05} format={(v) => `${v.toFixed(2)} lines`} onDone={(paraSpacing) => setSettings({ paraSpacing })} />
      <SliderRow c={c} label="Margins" value={s.margin} min={MARGIN.min} max={MARGIN.max} step={2} format={(v) => `${v}`} onDone={(margin) => setSettings({ margin })} />
      <Pressable onPress={resetSettings} style={[styles.reset, { borderColor: c.border }]}>
        <Text style={{ color: c.text, fontSize: 15 }}>Reset text and spacing</Text>
      </Pressable>
    </>
  );
}

const PRESETS = Object.keys(THEMES) as Exclude<ThemeName, 'custom'>[];

function ColorsTab({ s, c }: { s: ReaderSettings; c: Theme }) {
  const swatch = (name: ThemeName, t: Theme, label: string) => (
    <Pressable
      key={name}
      onPress={() => setSettings({ theme: name })}
      style={[styles.themeSwatch, { backgroundColor: t.bg, borderColor: s.theme === name ? c.accent : c.border }]}>
      <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Aa</Text>
      <Text style={{ color: t.muted, fontSize: 10, marginTop: 2 }}>{label}</Text>
    </Pressable>
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
        <Switch value={s.autoNight} onValueChange={(autoNight) => setSettings({ autoNight })} />
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
      <Row c={c} label="Tap left side to go forward">
        <Switch value={s.tapForward} onValueChange={(tapForward) => setSettings({ tapForward })} />
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
    <View style={[styles.segment, { backgroundColor: c.bg }]}>
      {options.map((o) => (
        <Pressable key={o} onPress={() => onPick(o)} style={[styles.segItem, o === value && { backgroundColor: c.accent }]}>
          <Text style={{ color: o === value ? '#fff' : c.text, fontSize: 13, fontWeight: '500' }}>{render(o)}</Text>
        </Pressable>
      ))}
    </View>
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
  return (
    <View style={[styles.segment, { backgroundColor: c.bg }]}>
      {options.map((o) => (
        <Pressable key={o.v} onPress={() => onPick(o.v)} accessibilityLabel={o.label} style={[styles.segIcon, o.v === value && { backgroundColor: c.accent }]}>
          <Ionicons name={o.icon} size={20} color={o.v === value ? '#fff' : c.text} />
        </Pressable>
      ))}
    </View>
  );
}

function Swatches({ c, colors, value, onPick }: { c: Theme; colors: string[]; value: string; onPick(v: string): void }) {
  return (
    <View style={styles.swatches}>
      {colors.map((col) => (
        <Pressable
          key={col}
          onPress={() => onPick(col)}
          accessibilityLabel={col}
          style={[styles.colorDot, { backgroundColor: col, borderColor: value.toLowerCase() === col.toLowerCase() ? c.accent : c.border }]}
        />
      ))}
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
  onDone,
  left,
  right,
  preview,
}: {
  c: Theme;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format(v: number): string;
  onDone(v: number): void;
  left?: ReactNode;
  right?: ReactNode;
  preview?(v: number): ReactNode;
}) {
  const [live, setLive] = useState<number | null>(null);
  const shown = live ?? value;
  return (
    <View style={styles.sliderBlock}>
      <View style={styles.sliderHead}>
        <Text style={[styles.label, { color: c.text }]}>{label}</Text>
        <Text style={{ color: c.muted, fontSize: 14 }}>{format(shown)}</Text>
      </View>
      {preview && live !== null ? <View style={styles.preview}>{preview(live)}</View> : null}
      <View style={styles.sliderRow}>
        {left}
        <Slider
          style={{ flex: 1, height: 36 }}
          minimumValue={min}
          maximumValue={max}
          step={step}
          value={value}
          onValueChange={(v) => setLive(Math.round(v / step) * step)}
          onSlidingComplete={(v) => {
            setLive(null);
            onDone(Math.round(v / step) * step);
          }}
          minimumTrackTintColor={c.accent}
          maximumTrackTintColor={c.border}
          thumbTintColor={c.accent}
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
  tabs: { flex: 1, flexDirection: 'row', borderRadius: 10, padding: 3 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 8 },
  body: { paddingHorizontal: 18, paddingBottom: 18 },
  fonts: { gap: 10, paddingVertical: 10 },
  fontCard: { width: 112, height: 82, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 50, gap: 12 },
  label: { fontSize: 15, flexShrink: 1 },
  segment: { flexDirection: 'row', borderRadius: 9, padding: 2 },
  segItem: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 7 },
  segIcon: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 7 },
  sliderBlock: { paddingTop: 10 },
  sliderHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  preview: { paddingVertical: 6, minHeight: 40, justifyContent: 'center' },
  reset: { alignSelf: 'center', marginTop: 18, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 9 },
  themeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingVertical: 10 },
  themeSwatch: { width: 60, height: 56, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  section: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginTop: 10, marginBottom: 6 },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  colorDot: { width: 34, height: 34, borderRadius: 17, borderWidth: 2 },
  hint: { fontSize: 13, lineHeight: 18, marginTop: 6 },
});
