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
  children: ReactNode;
}

export function Sheet({ visible, onClose, colors, title, height, right, children }: Props) {
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <View
          style={[
            styles.sheet,
            { backgroundColor: colors.bg, borderColor: colors.border, paddingBottom: insets.bottom + 12 },
            height ? { height: win.height * height } : { maxHeight: win.height * 0.85 },
          ]}>
          <View style={[styles.handle, { backgroundColor: colors.border }]} />
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
  handle: { alignSelf: 'center', width: 38, height: 5, borderRadius: 3, marginBottom: 6 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 8 },
  title: { fontSize: 18, fontWeight: '700' },
});
