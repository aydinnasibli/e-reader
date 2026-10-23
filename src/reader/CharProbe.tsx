// Measures the characters charWidths asks for: an invisible text per font,
// one character per line, whose line widths the text engine reports.

import { useEffect, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PROBE_SIZE, probeText, recordWidths, subscribeWidths, wantedWidths, widthsVersion } from './charWidths';

/** Give up on a batch the text engine never reports (it stays estimated). */
const TIMEOUT_MS = 3000;

export function CharProbe({ onMeasured }: { onMeasured(): void }) {
  const version = useSyncExternalStore(subscribeWidths, widthsVersion);
  const batches = wantedWidths();
  useEffect(() => {
    // Anything newly measured: what's drawn from widths is drawn again.
    if (version > 0) onMeasured();
  }, [version, onMeasured]);
  useEffect(() => {
    if (!batches.length) return;
    const timer = setTimeout(() => {
      for (const b of wantedWidths()) recordWidths(b.key, b.chars, null);
    }, TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [version, batches.length]);
  if (!batches.length) return null;
  return (
    <View pointerEvents="none" style={styles.hidden}>
      {batches.map(({ key, face, chars }) => (
        <Text
          key={`${key}|${chars.join('')}`}
          allowFontScaling={false}
          style={[face, styles.text]}
          onTextLayout={(e) => recordWidths(key, chars, e.nativeEvent.lines.map((l) => l.width))}>
          {probeText(chars)}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // Wide enough that no line wraps; out of sight.
  hidden: { position: 'absolute', left: -10000, top: 0, width: 4000, opacity: 0 },
  text: { fontSize: PROBE_SIZE, lineHeight: PROBE_SIZE * 1.5, letterSpacing: 0 },
});
