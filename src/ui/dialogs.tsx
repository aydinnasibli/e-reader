// Action sheets and text prompts that look the same on iOS and Android.
// Mount <DialogHost/> once; call showActions()/showPrompt() from anywhere.

import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Sheet } from './Sheet';
import { useAppColors } from './theme';

export interface Action {
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  destructive?: boolean;
  /** Shown with a check mark (for toggles like collection membership). */
  checked?: boolean;
  onPress(): void;
}

type Dialog =
  | { kind: 'actions'; title?: string; actions: Action[] }
  | { kind: 'prompt'; title: string; initial: string; placeholder?: string; confirm: string; onSubmit(text: string): void };

let current: Dialog | null = null;
let listener: ((d: Dialog | null) => void) | null = null;

function open(d: Dialog | null) {
  current = d;
  listener?.(d);
}

export function showActions(title: string | undefined, actions: Action[]) {
  open({ kind: 'actions', title, actions });
}

export function showPrompt(title: string, opts: { initial?: string; placeholder?: string; confirm?: string; onSubmit(text: string): void }) {
  open({ kind: 'prompt', title, initial: opts.initial ?? '', placeholder: opts.placeholder, confirm: opts.confirm ?? 'Save', onSubmit: opts.onSubmit });
}

export function DialogHost() {
  const c = useAppColors();
  const [dialog, setDialog] = useState<Dialog | null>(current);
  const [text, setText] = useState('');
  useEffect(() => {
    listener = (d) => {
      setDialog(d);
      if (d?.kind === 'prompt') setText(d.initial);
    };
    return () => {
      listener = null;
    };
  }, []);
  const close = () => open(null);
  const colors = { bg: c.elevated, text: c.text, border: c.border };

  return (
    <Sheet visible={!!dialog} onClose={close} colors={colors} title={dialog?.title}>
      {dialog?.kind === 'actions' &&
        dialog.actions.map((a, i) => (
          <Pressable
            key={i}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.chip }]}
            onPress={() => {
              close();
              // Let the sheet close before the action opens anything else.
              setTimeout(a.onPress, 250);
            }}>
            {a.icon ? <Ionicons name={a.icon} size={21} color={a.destructive ? c.danger : c.text} style={styles.icon} /> : null}
            <Text style={[styles.label, { color: a.destructive ? c.danger : c.text }]}>{a.label}</Text>
            {a.checked ? <Ionicons name="checkmark" size={20} color={c.accent} /> : null}
          </Pressable>
        ))}
      {dialog?.kind === 'prompt' && (
        <View style={styles.prompt}>
          <TextInput
            autoFocus
            value={text}
            onChangeText={setText}
            placeholder={dialog.placeholder}
            placeholderTextColor={c.secondary}
            style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.card }]}
            onSubmitEditing={() => {
              if (text.trim()) dialog.onSubmit(text.trim());
              close();
            }}
            returnKeyType="done"
          />
          <View style={styles.buttons}>
            <Pressable onPress={close} style={[styles.btn, { backgroundColor: c.chip }]}>
              <Text style={{ color: c.text, fontSize: 16 }}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (text.trim()) dialog.onSubmit(text.trim());
                close();
              }}
              style={[styles.btn, { backgroundColor: c.accent }]}>
              <Text style={{ color: c.accentText, fontSize: 16, fontWeight: '600' }}>{dialog.confirm}</Text>
            </Pressable>
          </View>
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, minHeight: 52 },
  icon: { width: 32 },
  label: { flex: 1, fontSize: 17 },
  prompt: { paddingHorizontal: 20, paddingTop: 4, gap: 14 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 17 },
  buttons: { flexDirection: 'row', gap: 10 },
  btn: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 10 },
});
