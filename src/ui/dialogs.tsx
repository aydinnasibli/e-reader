// Action sheets and text prompts that look the same on iOS and Android.
// Mount <DialogHost/> once; call showActions()/showPrompt() from anywhere.

import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Sheet } from './Sheet';
import { useAppColors } from './theme';
import { Tap } from '@/ui/Tap';

export interface Action {
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  destructive?: boolean;
  /** Shown with a check mark (for toggles like collection membership). */
  checked?: boolean;
  onPress(): void;
}

export interface PromptOptions {
  initial?: string;
  placeholder?: string;
  /** The button's label; "Save" if not given. */
  confirm?: string;
  multiline?: boolean;
  /** Saving an empty field is allowed (it clears the value); otherwise it does nothing. */
  allowEmpty?: boolean;
  onSubmit(text: string): void;
}

type Dialog = { kind: 'actions'; title?: string; actions: Action[] } | ({ kind: 'prompt'; title: string } & PromptOptions);

let current: Dialog | null = null;
let listener: ((d: Dialog | null) => void) | null = null;

function open(d: Dialog | null) {
  current = d;
  listener?.(d);
}

export function showActions(title: string | undefined, actions: Action[]) {
  open({ kind: 'actions', title, actions });
}

export function showPrompt(title: string, opts: PromptOptions) {
  open({ kind: 'prompt', title, ...opts });
}

export function DialogHost() {
  const c = useAppColors();
  const [dialog, setDialog] = useState<Dialog | null>(current);
  const [text, setText] = useState('');
  useEffect(() => {
    listener = (d) => {
      setDialog(d);
      if (d?.kind === 'prompt') setText(d.initial ?? '');
    };
    return () => {
      listener = null;
    };
  }, []);
  const close = () => open(null);
  const submit = () => {
    if (dialog?.kind !== 'prompt') return;
    const value = text.trim();
    if (value || dialog.allowEmpty) dialog.onSubmit(value);
    close();
  };
  const colors = { bg: c.elevated, text: c.text, border: c.border };
  // A phone on its side has little room above the keyboard: a one-line box gets its buttons beside it.
  const beside = useWindowDimensions().height < 500 && dialog?.kind === 'prompt' && !dialog.multiline;

  return (
    <Sheet visible={!!dialog} onClose={close} colors={colors} title={dialog?.title} position={dialog?.kind === 'prompt' ? 'top' : 'bottom'} scroll>
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
        <View style={[styles.prompt, beside && styles.promptBeside]}>
          <TextInput
            autoFocus
            value={text}
            onChangeText={setText}
            placeholder={dialog.placeholder}
            placeholderTextColor={c.secondary}
            multiline={dialog.multiline}
            style={[styles.input, dialog.multiline && styles.multiline, beside && styles.grow, { color: c.text, borderColor: c.border, backgroundColor: c.card }]}
            onSubmitEditing={submit}
            returnKeyType="done"
          />
          <View style={styles.buttons}>
            <Tap onPress={close} style={[styles.btn, beside && styles.btnBeside, { backgroundColor: c.chip }]}>
              <Text style={{ color: c.text, fontSize: 16 }}>Cancel</Text>
            </Tap>
            <Tap
              onPress={submit}
              style={[styles.btn, beside && styles.btnBeside, { backgroundColor: c.accent }]}>
              <Text style={{ color: c.accentText, fontSize: 16, fontWeight: '600' }}>{dialog.confirm ?? 'Save'}</Text>
            </Tap>
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
  // The text box gives way first when the card has to shrink (small screens, keyboard up).
  prompt: { paddingHorizontal: 20, paddingTop: 4, gap: 14, flexShrink: 1 },
  promptBeside: { flexDirection: 'row', gap: 10 },
  grow: { flex: 1 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 17 },
  multiline: { minHeight: 64, height: 110, flexShrink: 1, textAlignVertical: 'top' },
  buttons: { flexDirection: 'row', gap: 10 },
  btn: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 10 },
  btnBeside: { flex: 0, justifyContent: 'center', paddingHorizontal: 18 },
});
