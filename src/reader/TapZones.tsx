// Shown once, the first time a book is read in page mode: where to tap.

import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Theme } from '@/lib/settings';
import { TAP_EDGE } from './gestures';

/** The labels grow with the phone's text size only this far (a side zone is narrow). */
const LABEL_SCALE = 1.3;

export function TapZones({ theme, tapForward, onDismiss }: { theme: Theme; tapForward: boolean; onDismiss(): void }) {
  // The side zones are a quarter of the screen wide: their labels are two short lines (not one word
  // broken wherever it runs out of room), shrunk to fit at the largest text sizes.
  const zone = (flex: number, icon: keyof typeof Ionicons.glyphMap, label: string, tint: string) => (
    <View style={[styles.zone, { flex, backgroundColor: tint }]}>
      <Ionicons name={icon} size={30} color="#fff" />
      <Text style={styles.label} numberOfLines={2} adjustsFontSizeToFit maxFontSizeMultiplier={LABEL_SCALE}>
        {label}
      </Text>
    </View>
  );
  return (
    <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} accessibilityLabel="Got it">
      <View style={styles.row}>
        {zone(TAP_EDGE, tapForward ? 'arrow-forward' : 'arrow-back', tapForward ? 'Next\npage' : 'Previous\npage', 'rgba(0,0,0,0.55)')}
        {zone(1 - 2 * TAP_EDGE, 'menu', 'Menu', 'rgba(0,0,0,0.38)')}
        {zone(TAP_EDGE, 'arrow-forward', 'Next\npage', 'rgba(0,0,0,0.55)')}
      </View>
      <View style={[styles.note, { backgroundColor: theme.chrome }]}>
        <Text style={{ color: theme.text, fontSize: 15, textAlign: 'center' }}>Tap a side to turn the page, or swipe. Tap anywhere to start reading.</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row' },
  zone: { alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 6, borderRightWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.5)' },
  label: { color: '#fff', fontSize: 15, fontWeight: '600', textAlign: 'center' },
  note: { position: 'absolute', left: 24, right: 24, bottom: 60, borderRadius: 14, padding: 14 },
});
