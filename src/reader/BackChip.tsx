// "Back to page 34": shown after a jump (contents, search, slider, a note),
// to return to where you were reading. Also "Finished" at the end of a book.

import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Theme } from '@/lib/settings';
import { Tap } from '@/ui/Tap';

interface Props {
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  theme: Theme;
  onPress(): void;
  onDismiss(): void;
}

export function BackChip({ label, icon = 'arrow-undo', theme, onPress, onDismiss }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.chip, { bottom: insets.bottom + 40, left: 16 + insets.left, backgroundColor: theme.chrome, borderColor: theme.border }]}>
      <Tap onPress={onPress} style={styles.main} hitSlop={6} accessibilityLabel={label}>
        <Ionicons name={icon} size={16} color={theme.accent} />
        <Text style={{ color: theme.text, fontSize: 14, fontWeight: '600' }}>{label}</Text>
      </Tap>
      <Tap onPress={onDismiss} hitSlop={10} style={styles.close} accessibilityLabel="Dismiss">
        <Ionicons name="close" size={16} color={theme.muted} />
      </Tap>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 7,
    gap: 8,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  main: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  close: { padding: 2 },
});
