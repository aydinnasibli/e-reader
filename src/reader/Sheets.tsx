// Contents list and reading settings, shown as bottom sheets.

import { type ReactNode, useEffect, useRef } from 'react';
import { FlatList, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { TocEntry } from '@/engine/types';
import {
  FONT_SIZES,
  LINE_SPACINGS,
  MARGINS,
  type ReaderSettings,
  THEMES,
  type Theme,
  type ThemeName,
  setSettings,
} from '@/lib/settings';

function Sheet({ visible, onClose, theme, children, tall }: { visible: boolean; onClose(): void; theme: Theme; children: ReactNode; tall?: boolean }) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View
        style={[
          styles.sheet,
          { backgroundColor: theme.chrome, borderColor: theme.border, paddingBottom: insets.bottom + 12 },
          tall && { height: height * 0.75 },
        ]}>
        <View style={[styles.handle, { backgroundColor: theme.border }]} />
        {children}
      </View>
    </Modal>
  );
}

export function TocSheet({
  visible,
  onClose,
  theme,
  toc,
  currentBlock,
  preparing,
  onPick,
}: {
  visible: boolean;
  onClose(): void;
  theme: Theme;
  toc: TocEntry[];
  currentBlock: number;
  preparing: boolean;
  onPick(entry: TocEntry): void;
}) {
  let current = -1;
  for (let i = 0; i < toc.length && toc[i].b <= currentBlock; i++) current = i;
  const list = useRef<FlatList<TocEntry>>(null);
  useEffect(() => {
    if (visible && current > 3) setTimeout(() => list.current?.scrollToIndex({ index: current, viewPosition: 0.3, animated: false }), 50);
  }, [visible, current]);

  return (
    <Sheet visible={visible} onClose={onClose} theme={theme} tall>
      <Text style={[styles.sheetTitle, { color: theme.text }]}>Contents</Text>
      {toc.length === 0 ? (
        <Text style={[styles.empty, { color: theme.muted }]}>
          {preparing ? 'The contents will appear when the book has finished preparing.' : 'This book has no table of contents.'}
        </Text>
      ) : (
        <FlatList
          ref={list}
          data={toc}
          keyExtractor={(_, i) => String(i)}
          getItemLayout={(_, i) => ({ length: 48, offset: 48 * i, index: i })}
          renderItem={({ item, index }) => (
            <Pressable onPress={() => onPick(item)} style={[styles.tocRow, { paddingLeft: 20 + Math.min(item.l, 4) * 18 }]}>
              <Text
                numberOfLines={1}
                style={{ color: index === current ? theme.accent : theme.text, fontSize: 16, fontWeight: index === current ? '700' : '400' }}>
                {item.t}
              </Text>
            </Pressable>
          )}
        />
      )}
    </Sheet>
  );
}

function Row({ label, theme, children }: { label: string; theme: Theme; children: ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
      <View style={styles.rowRight}>{children}</View>
    </View>
  );
}

function Choice<T>({ options, value, onPick, theme, render }: { options: T[]; value: T; onPick(v: T): void; theme: Theme; render(v: T): string }) {
  return (
    <View style={[styles.segment, { borderColor: theme.border }]}>
      {options.map((o, i) => (
        <Pressable
          key={i}
          onPress={() => onPick(o)}
          style={[styles.segItem, o === value && { backgroundColor: theme.accent }]}>
          <Text style={{ color: o === value ? '#fff' : theme.text, fontSize: 14 }}>{render(o)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function SettingsSheet({ visible, onClose, theme, settings }: { visible: boolean; onClose(): void; theme: Theme; settings: ReaderSettings }) {
  const sizeIndex = FONT_SIZES.indexOf(settings.fontSize);
  const step = (d: number) => {
    const i = Math.max(0, Math.min(FONT_SIZES.length - 1, (sizeIndex < 0 ? 5 : sizeIndex) + d));
    setSettings({ fontSize: FONT_SIZES[i] });
  };
  return (
    <Sheet visible={visible} onClose={onClose} theme={theme}>
      <ScrollView>
        <Row label="Text size" theme={theme}>
          <Pressable onPress={() => step(-1)} style={[styles.stepBtn, { borderColor: theme.border }]}>
            <Text style={{ color: theme.text, fontSize: 15 }}>A−</Text>
          </Pressable>
          <Text style={{ color: theme.text, width: 34, textAlign: 'center' }}>{settings.fontSize}</Text>
          <Pressable onPress={() => step(1)} style={[styles.stepBtn, { borderColor: theme.border }]}>
            <Text style={{ color: theme.text, fontSize: 20 }}>A+</Text>
          </Pressable>
        </Row>
        <Row label="Theme" theme={theme}>
          {(Object.keys(THEMES) as ThemeName[]).map((name) => (
            <Pressable
              key={name}
              onPress={() => setSettings({ theme: name })}
              style={[
                styles.swatch,
                { backgroundColor: THEMES[name].bg, borderColor: settings.theme === name ? theme.accent : theme.border },
              ]}>
              <Text style={{ color: THEMES[name].text, fontSize: 14 }}>Aa</Text>
            </Pressable>
          ))}
        </Row>
        <Row label="Mode" theme={theme}>
          <Choice options={['page', 'scroll'] as const as ('page' | 'scroll')[]} value={settings.mode} onPick={(mode) => setSettings({ mode })} theme={theme} render={(m) => (m === 'page' ? 'Pages' : 'Scroll')} />
        </Row>
        <Row label="Font" theme={theme}>
          <Choice options={['serif', 'sans'] as ('serif' | 'sans')[]} value={settings.font} onPick={(font) => setSettings({ font })} theme={theme} render={(f) => (f === 'serif' ? 'Serif' : 'Sans')} />
        </Row>
        <Row label="Line spacing" theme={theme}>
          <Choice options={LINE_SPACINGS} value={settings.lineSpacing} onPick={(lineSpacing) => setSettings({ lineSpacing })} theme={theme} render={(v) => (v === LINE_SPACINGS[0] ? 'Tight' : v === LINE_SPACINGS[1] ? 'Normal' : 'Loose')} />
        </Row>
        <Row label="Margins" theme={theme}>
          <Choice options={MARGINS} value={settings.margin} onPick={(margin) => setSettings({ margin })} theme={theme} render={(v) => (v === MARGINS[0] ? 'Narrow' : v === MARGINS[1] ? 'Normal' : 'Wide')} />
        </Row>
        <Row label="Justify text" theme={theme}>
          <Switch value={settings.justify} onValueChange={(justify) => setSettings({ justify })} />
        </Row>
        <Row label="Indent paragraphs" theme={theme}>
          <Switch value={settings.indent} onValueChange={(indent) => setSettings({ indent })} />
        </Row>
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8 },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginBottom: 8 },
  sheetTitle: { fontSize: 18, fontWeight: '700', paddingHorizontal: 20, paddingVertical: 8 },
  empty: { paddingHorizontal: 20, paddingVertical: 24, fontSize: 15 },
  tocRow: { height: 48, justifyContent: 'center', paddingRight: 20 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 10, minHeight: 52 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { fontSize: 16 },
  segment: { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, overflow: 'hidden' },
  segItem: { paddingHorizontal: 12, paddingVertical: 7 },
  stepBtn: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 4 },
  swatch: { width: 40, height: 40, borderRadius: 20, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
