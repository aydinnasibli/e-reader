// An icon button in the navigation bar. Each is a 44-point square: a
// finger-sized target that the header doesn't cut down (it ignores taps
// outside its buttons' boxes).

import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet } from 'react-native';
import { Tap } from '@/ui/Tap';

export function HeaderButton({ icon, size = 22, color, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; size?: number; color: string; label: string; onPress(): void }) {
  return (
    <Tap onPress={onPress} style={headerButton.box} accessibilityLabel={label}>
      <Ionicons name={icon} size={size} color={color} />
    </Tap>
  );
}

/** The button's box, for something drawn in its place (a spinner while it works). */
export const headerButton = StyleSheet.create({
  box: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
