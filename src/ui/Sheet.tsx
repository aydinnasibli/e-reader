// Bottom sheet used for menus, settings, contents and dialogs. On a tablet or
// a phone on its side it is a column in the middle (like an iPad form sheet)
// instead of stretching edge to edge.

import { type ReactNode, useEffect, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { columnPadding } from './layout';

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
   * 'top' for sheets with a text field: a card near the top of the screen, in
   * the part the keyboard leaves free. On iOS the keyboard pads the sheet, so
   * the card ends above it; Android doesn't always resize the window for the
   * keyboard, so there the card is kept to the space the keyboard leaves.
   */
  position?: 'bottom' | 'top';
  /**
   * Scroll the content when it doesn't fit: long menus, large text, landscape,
   * a keyboard taking half the screen. (Not for content that scrolls itself.)
   */
  scroll?: boolean;
  children: ReactNode;
}

/** The keyboard's height while it's up, 0 when it isn't. */
function useKeyboardHeight() {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', (e) => setHeight(e.endCoordinates.height));
    const hidden = Keyboard.addListener('keyboardDidHide', () => setHeight(0));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  return height;
}

export function Sheet({ visible, onClose, colors, title, height, right, position = 'bottom', scroll, children }: Props) {
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const keyboard = useKeyboardHeight();
  const top = position === 'top';
  // A phone on its side: little room above the keyboard.
  const short = win.height < 500;
  // The shared column, clear of the notch (a card also keeps off the screen's edges).
  const column = columnPadding(win.width, insets, top ? 12 : 0);
  const sides = { marginLeft: column.paddingLeft, marginRight: column.paddingRight };
  return (
    <Modal visible={visible} transparent animationType={top ? 'fade' : 'slide'} onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <KeyboardAvoidingView
        // A bottom sheet never reaches under the status bar: when the keyboard
        // takes the lower part of the screen, a tall sheet (search) shrinks to
        // the space left instead of being pushed off the top with its text box.
        style={[styles.fill, top ? { justifyContent: 'flex-start', paddingTop: insets.top + 16 } : { paddingTop: insets.top + 8 }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <View
          style={[
            top
              ? [styles.card, sides, { backgroundColor: colors.bg, borderColor: colors.border }]
              : [styles.sheet, sides, { backgroundColor: colors.bg, borderColor: colors.border, paddingBottom: insets.bottom + 12 }],
            height
              ? { height: win.height * height }
              : top
                ? [styles.cardSize, Platform.OS === 'android' && keyboard ? { maxHeight: win.height - insets.top - 16 - keyboard - 12 } : null]
                : { maxHeight: win.height * 0.85 },
          ]}>
          {top ? null : <View style={[styles.handle, { backgroundColor: colors.border }]} />}
          {title ? (
            <View style={[styles.titleRow, top && short && styles.titleRowShort]}>
              <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
              {right}
            </View>
          ) : null}
          {scroll ? (
            <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              {children}
            </ScrollView>
          ) : (
            children
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, flexShrink: 1 },
  card: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, paddingTop: 8, paddingBottom: 12 },
  // As tall as its content, shrinking (the content scrolls) where the keyboard leaves less.
  cardSize: { flexShrink: 1 },
  handle: { alignSelf: 'center', width: 38, height: 5, borderRadius: 3, marginBottom: 6 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 8 },
  titleRowShort: { paddingVertical: 4 },
  title: { fontSize: 18, fontWeight: '700' },
  scroll: { flexGrow: 0, flexShrink: 1 },
});
