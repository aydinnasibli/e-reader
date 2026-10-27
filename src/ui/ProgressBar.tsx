import { type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';

/** A thin bar filled to `value` (0–1): reading progress, a download. */
export function ProgressBar({ value, color, track, height = 3, style }: { value: number; color: string; track: string; height?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.track, { height, backgroundColor: track }, style]}>
      <View style={{ height, width: `${Math.round(value * 100)}%`, backgroundColor: color }} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { borderRadius: 2, overflow: 'hidden' },
});
