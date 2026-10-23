// Bottom sheet used for menus, settings, contents and dialogs.

import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface SheetColors {
  bg: string;
  text: string;
  border: string;
}

interface Props {
  visible: boolean;
  onClose(): void;
  colors: SheetColors;
  title?: string;
  /** Fraction of screen height, for sheets with long lists. */
  height?: number;
  right?: ReactNode;
  /**
   * 'top' for sheets with a text field: a card near the top of the screen,
   * where the keyboard can't cover it. (Android draws these edge to edge and
   * doesn't move them up for the keyboard.)
   */
  position?: 'bottom' | 'top';
  children: ReactNode;
}

export function Sheet({ visible, onClose, colors, title, height, right, position = 'bottom', children }: Props) {
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const top = position === 'top';
  return (
    <Modal visible={visible} transparent animationType={top ? 'fade' : 'slide'} onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <KeyboardAvoidingView
        style={[styles.fill, top && { justifyContent: 'flex-start', paddingTop: insets.top + 40 }]}
        behavior={Platform.OS === 'ios' && !top ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <View
          style={[
            top
              ? [styles.card, { backgroundColor: colors.bg, borderColor: colors.border, marginLeft: insets.left + 12, marginRight: insets.right + 12 }]
              : [styles.sheet, { backgroundColor: colors.bg, borderColor: colors.border, paddingBottom: insets.bottom + 12, paddingLeft: insets.left, paddingRight: insets.right }],
            height ? { height: win.height * height } : { maxHeight: win.height * (top ? 0.5 : 0.85) },
          ]}>
          {top ? null : <View style={[styles.handle, { backgroundColor: colors.border }]} />}
          {title ? (
            <View style={styles.titleRow}>
              <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
              {right}
            </View>
          ) : null}
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8 },
  card: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, paddingTop: 8, paddingBottom: 12 },
  handle: { alignSelf: 'center', width: 38, height: 5, borderRadius: 3, marginBottom: 6 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 8 },
  title: { fontSize: 18, fontWeight: '700' },
});
