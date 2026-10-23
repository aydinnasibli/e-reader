// Long-press a word to get here, with that word selected. Tap other words to
// extend the selection (or a word inside it to start over from there), then
// highlight, annotate, copy, look up, translate or share. Look up and
// translate show their answer right here, never in a browser. Works the same
// on both platforms and in Expo Go.

import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { type Block, blockText } from '@/engine/types';
import { type Highlight, addHighlight, clearHighlightRange, updateHighlight, useAnnotations } from '@/lib/annotations';
import type { Theme } from '@/lib/settings';
import { confirmDeleteHighlight, hasNote } from '@/ui/confirm';
import { showPrompt } from '@/ui/dialogs';
import { Sheet } from '@/ui/Sheet';
import { HIGHLIGHT_COLORS, type HighlightColor } from '@/ui/theme';
import { LookupCard, type LookupKind } from './LookupCard';
import { type Sel, tapWord, tokenize, tokensFor, wordAt } from './selection';

interface Props {
  bookId: string;
  bookTitle: string;
  lang?: string;
  /** Global block index, the block, and the character pressed; null when closed. */
  target: { b: number; block: Block; chapter?: string; at?: number } | null;
  theme: Theme;
  onClose(): void;
}

export function highlightColor(color: HighlightColor, dark: boolean) {
  return HIGHLIGHT_COLORS[color][dark ? 'dark' : 'light'];
}

export function SelectionSheet({ bookId, bookTitle, lang, target, theme, onClose }: Props) {
  const ann = useAnnotations(bookId);
  const text = useMemo(() => (target ? blockText(target.block) : ''), [target]);
  const tokens = useMemo(() => tokenize(text), [text]);
  // Start with the long-pressed word selected.
  const initialSel = (): Sel | null => {
    if (!target || target.at === undefined) return null;
    const i = wordAt(tokens, target.at);
    return i < 0 ? null : { a: i, z: i };
  };
  const [kept, setSel] = useState<Sel | null>(initialSel);
  const [lastTarget, setLastTarget] = useState(target);
  // A definition or translation shown in place of the selection.
  const [keptLookup, setLookup] = useState<LookupKind | null>(null);
  let sel = kept;
  let lookup = keptLookup;
  if (target !== lastTarget) {
    // A new paragraph (or the sheet closing). The state update applies on the
    // next render; this one must not use the old selection with the new text.
    sel = initialSel();
    lookup = null;
    setLastTarget(target);
    setSel(sel);
    setLookup(null);
  }
  if (sel && !(tokens[sel.a] && tokens[sel.z])) sel = null;

  const highlights = target ? ann.highlights.filter((h) => h.b === target.b) : [];
  // Nothing selected means the whole paragraph.
  const range: [number, number] = sel ? [tokens[sel.a].start, tokens[sel.z].start + tokens[sel.z].text.length] : [0, text.length];
  const selectedText = text.slice(range[0], range[1]);
  // A highlight that is exactly the selection: colours and notes edit it.
  const exact: Highlight | undefined = highlights.find((h) => h.s === range[0] && h.e === range[1]);
  // Any highlighting inside the selection, which "Remove" clears.
  const touched = highlights.some((h) => h.s < range[1] && range[0] < h.e);
  // The highlight the selection sits inside, offered as a quick selection.
  const around = exact ? undefined : highlights.find((h) => h.s <= range[0] && range[1] <= h.e);

  const tap = (i: number) => {
    if (!tokens[i].word) return;
    Haptics.selectionAsync().catch(() => {});
    setSel(tapWord(sel, i));
  };
  const selectRange = (s: number, e: number) => {
    Haptics.selectionAsync().catch(() => {});
    setSel(tokensFor(tokens, s, e));
  };

  const close = (then?: () => void) => {
    onClose();
    if (then) setTimeout(then, 350);
  };

  const applyColor = (color: HighlightColor) => {
    if (!target) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (exact) updateHighlight(bookId, exact.id, { color });
    else {
      const [s, e] = range;
      addHighlight(bookId, { b: target.b, s, e, color, text: text.slice(s, e), chapter: target.chapter });
    }
    close();
  };

  const note = () => {
    if (!target) return;
    const t = target;
    const [s, e] = range;
    const ex = exact;
    close(() =>
      showPrompt(ex?.note ? 'Edit note' : 'Add note', {
        initial: ex?.note ?? '',
        placeholder: 'Your note',
        multiline: true,
        // Emptying an existing note removes it.
        allowEmpty: !!ex?.note,
        onSubmit: (n) => {
          if (ex) updateHighlight(bookId, ex.id, { note: n || undefined });
          else addHighlight(bookId, { b: t.b, s, e, color: 'yellow', text: text.slice(s, e), note: n, chapter: t.chapter });
        },
      }),
    );
  };

  // Look up the selected word (the first one when more are selected); translate the whole selection.
  const canLookUp = !!sel || tokens.filter((t) => t.word).length === 1;
  const lookupText = (kind: LookupKind) =>
    kind === 'define' && sel ? (tokens.slice(sel.a, sel.z + 1).find((t) => t.word)?.text ?? selectedText) : selectedText;

  const copy = async () => {
    await Clipboard.setStringAsync(selectedText);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    close();
  };

  const share = () => close(() => Share.share({ message: `“${selectedText}”\n— ${bookTitle}` }).catch(() => {}));

  const sheetColors = { bg: theme.chrome, text: theme.text, border: theme.border };
  const selBg = theme.accent + '55';

  return (
    <Sheet visible={!!target} onClose={() => close()} colors={sheetColors}>
      {lookup ? (
        <LookupCard key={lookup} kind={lookup} text={lookupText(lookup).trim()} lang={lang} theme={theme} onBack={() => setLookup(null)} onSwitch={setLookup} />
      ) : (
        <>
          <Text style={[styles.hint, { color: theme.muted }]}>
            {sel ? 'Tap words to extend the selection, or a selected word to start over' : 'Whole paragraph selected. Tap a word to select it instead'}
          </Text>
          <View style={styles.chips}>
            {sel ? (
              <Chip label="Whole paragraph" onPress={() => setSel(null)} theme={theme} />
            ) : null}
            {around ? <Chip label="Select highlight" onPress={() => selectRange(around.s, around.e)} theme={theme} /> : null}
          </View>
          <ScrollView style={styles.textBox} contentContainerStyle={styles.textPad}>
            <Text style={[styles.text, { color: theme.text }]}>
              {tokens.map((t, i) => {
                const inSel = sel ? i >= sel.a && i <= sel.z : false;
                const h = highlights.find((x) => x.s <= t.start && t.start < x.e);
                const bg = inSel ? selBg : h ? highlightColor(h.color, theme.dark) : undefined;
                return (
                  <Text key={i} onPress={t.word ? () => tap(i) : undefined} style={bg ? { backgroundColor: bg } : undefined}>
                    {t.text}
                  </Text>
                );
              })}
            </Text>
          </ScrollView>
          <View style={styles.colors}>
            {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((col) => (
              <Pressable
                key={col}
                onPress={() => applyColor(col)}
                accessibilityLabel={`Highlight ${col}`}
                style={[
                  styles.dot,
                  { backgroundColor: highlightColor(col, theme.dark), borderColor: exact?.color === col ? theme.text : 'transparent' },
                ]}
              />
            ))}
            {touched && target ? (
              <Pressable
                onPress={() => {
                  const clear = () => {
                    clearHighlightRange(bookId, target.b, range[0], range[1]);
                    close();
                  };
                  // A note goes when its whole highlight does (one that is only trimmed keeps it): ask first.
                  if (highlights.some((h) => hasNote(h) && range[0] <= h.s && h.e <= range[1])) confirmDeleteHighlight(true, clear);
                  else clear();
                }}
                style={styles.dotBtn}
                accessibilityLabel="Remove highlight">
                <Ionicons name="close-circle-outline" size={30} color={theme.muted} />
              </Pressable>
            ) : null}
          </View>
          <View style={[styles.actions, { borderColor: theme.border }]}>
            <Action icon="create-outline" label={exact?.note ? 'Edit note' : 'Note'} onPress={note} theme={theme} />
            <Action icon="copy-outline" label="Copy" onPress={copy} theme={theme} />
            <Action icon="book-outline" label="Look up" onPress={() => setLookup('define')} disabled={!canLookUp} theme={theme} />
            <Action icon="language-outline" label="Translate" onPress={() => setLookup('translate')} theme={theme} />
            <Action icon="share-outline" label="Share" onPress={share} theme={theme} />
          </View>
        </>
      )}
    </Sheet>
  );
}

function Chip({ label, onPress, theme }: { label: string; onPress(): void; theme: Theme }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.chip, { borderColor: theme.border, opacity: pressed ? 0.5 : 1 }]}>
      <Text style={{ color: theme.text, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

function Action({
  icon,
  label,
  onPress,
  disabled,
  theme,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress(): void;
  disabled?: boolean;
  theme: Theme;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.action, (pressed || disabled) && { opacity: disabled ? 0.35 : 0.5 }]}>
      <Ionicons name={icon} size={24} color={theme.text} />
      <Text style={{ color: theme.text, fontSize: 12, marginTop: 4 }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 13, paddingHorizontal: 20, paddingBottom: 6 },
  chips: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, paddingBottom: 8 },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 5 },
  textBox: { maxHeight: 260, marginHorizontal: 12 },
  textPad: { paddingHorizontal: 8, paddingBottom: 8 },
  text: { fontSize: 18, lineHeight: 28 },
  colors: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 12 },
  dot: { width: 34, height: 34, borderRadius: 17, borderWidth: 2 },
  dotBtn: { marginLeft: 'auto' },
  actions: { flexDirection: 'row', justifyContent: 'space-around', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12 },
  action: { alignItems: 'center', minWidth: 60 },
});
