// Long-press a paragraph to get here. Tap a word to start a selection and
// another to extend it, then highlight, annotate, copy, look up, translate or
// share. Works the same on both platforms and in Expo Go.

import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { getLocales } from 'expo-localization';
import * as WebBrowser from 'expo-web-browser';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { type Block, blockText } from '@/engine/types';
import { type Highlight, addHighlight, removeHighlight, updateHighlight, useAnnotations } from '@/lib/annotations';
import type { Theme } from '@/lib/settings';
import { showPrompt } from '@/ui/dialogs';
import { Sheet } from '@/ui/Sheet';
import { HIGHLIGHT_COLORS, type HighlightColor } from '@/ui/theme';

interface Props {
  bookId: string;
  bookTitle: string;
  lang?: string;
  /** Global block index and the block itself; null when closed. */
  target: { b: number; block: Block; chapter?: string } | null;
  theme: Theme;
  onClose(): void;
}

interface Token {
  text: string;
  start: number;
  word: boolean;
}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /\s+|[^\s]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ text: m[0], start: m.index, word: !/^\s/.test(m[0]) });
  return out;
}

export function highlightColor(color: HighlightColor, dark: boolean) {
  return HIGHLIGHT_COLORS[color][dark ? 'dark' : 'light'];
}

export function SelectionSheet({ bookId, bookTitle, lang, target, theme, onClose }: Props) {
  const ann = useAnnotations(bookId);
  const text = useMemo(() => (target ? blockText(target.block) : ''), [target]);
  const tokens = useMemo(() => tokenize(text), [text]);
  const [sel, setSel] = useState<{ a: number; z: number; taps: number } | null>(null);
  const [lastTarget, setLastTarget] = useState(target);
  if (target !== lastTarget) {
    setLastTarget(target);
    setSel(null);
  }

  const highlights = target ? ann.highlights.filter((h) => h.b === target.b) : [];
  const range: [number, number] | null = sel
    ? [tokens[sel.a].start, tokens[sel.z].start + tokens[sel.z].text.length]
    : null;
  const selectedText = range ? text.slice(range[0], range[1]) : text;
  // The highlight the selection sits in, if any.
  const existing: Highlight | undefined = range
    ? highlights.find((h) => h.s <= range[0] && range[1] <= h.e)
    : undefined;

  const tap = (i: number) => {
    if (!tokens[i].word) return;
    Haptics.selectionAsync().catch(() => {});
    // Tapping inside a highlight with nothing selected selects that highlight.
    const at = tokens[i].start;
    const h = highlights.find((x) => x.s <= at && at < x.e);
    if (!sel && h) {
      const a = tokens.findIndex((t) => t.start + t.text.length > h.s && t.word);
      let z = a;
      for (let k = a; k < tokens.length && tokens[k].start < h.e; k++) if (tokens[k].word) z = k;
      setSel({ a, z, taps: 2 });
      return;
    }
    if (!sel || sel.taps >= 2) setSel({ a: i, z: i, taps: 1 });
    else setSel({ a: Math.min(sel.a, i), z: Math.max(sel.z, i), taps: 2 });
  };

  const close = (then?: () => void) => {
    onClose();
    if (then) setTimeout(then, 350);
  };

  const applyColor = (color: HighlightColor) => {
    if (!target) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (existing) updateHighlight(bookId, existing.id, { color });
    else {
      const [s, e] = range ?? [0, text.length];
      addHighlight(bookId, { b: target.b, s, e, color, text: text.slice(s, e), chapter: target.chapter });
    }
    close();
  };

  const note = () => {
    if (!target) return;
    const t = target;
    const [s, e] = range ?? [0, text.length];
    const ex = existing;
    close(() =>
      showPrompt(ex?.note ? 'Edit note' : 'Add note', {
        initial: ex?.note ?? '',
        placeholder: 'Your note',
        multiline: true,
        onSubmit: (n) => {
          if (ex) updateHighlight(bookId, ex.id, { note: n });
          else addHighlight(bookId, { b: t.b, s, e, color: 'yellow', text: text.slice(s, e), note: n, chapter: t.chapter });
        },
      }),
    );
  };

  const lookUp = () => {
    const word = selectedText.replace(/[.,!?;:"“”‘’«»„()[\]{}…—–*_]/g, '').trim();
    const code = (lang || getLocales()[0]?.languageCode || 'en').slice(0, 2).toLowerCase();
    const url = word.includes(' ')
      ? `https://www.google.com/search?q=${encodeURIComponent('define ' + word)}`
      : `https://${code}.wiktionary.org/wiki/${encodeURIComponent(word.toLowerCase())}`;
    close(() => WebBrowser.openBrowserAsync(url).catch(() => {}));
  };

  const translate = () => {
    const to = getLocales()[0]?.languageCode ?? 'en';
    const url = `https://translate.google.com/?sl=auto&tl=${to}&text=${encodeURIComponent(selectedText)}&op=translate`;
    close(() => WebBrowser.openBrowserAsync(url).catch(() => {}));
  };

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
      <Text style={[styles.hint, { color: theme.muted }]}>
        {sel ? (sel.taps === 1 ? 'Tap another word to extend the selection' : 'Selection ready') : 'Tap a word to select, or use the whole paragraph'}
      </Text>
      <ScrollView style={styles.textBox} contentContainerStyle={styles.textPad}>
        <Text style={[styles.text, { color: theme.text }]}>
          {tokens.map((t, i) => {
            const inSel = sel && i >= sel.a && i <= sel.z;
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
              { backgroundColor: highlightColor(col, theme.dark), borderColor: existing?.color === col ? theme.text : 'transparent' },
            ]}
          />
        ))}
        {existing ? (
          <Pressable
            onPress={() => {
              removeHighlight(bookId, existing.id);
              close();
            }}
            style={styles.dotBtn}
            accessibilityLabel="Remove highlight">
            <Ionicons name="close-circle-outline" size={30} color={theme.muted} />
          </Pressable>
        ) : null}
      </View>
      <View style={[styles.actions, { borderColor: theme.border }]}>
        <Action icon="create-outline" label={existing?.note ? 'Edit note' : 'Note'} onPress={note} theme={theme} />
        <Action icon="copy-outline" label="Copy" onPress={copy} theme={theme} />
        <Action icon="book-outline" label="Look up" onPress={lookUp} theme={theme} />
        <Action icon="language-outline" label="Translate" onPress={translate} theme={theme} />
        <Action icon="share-outline" label="Share" onPress={share} theme={theme} />
      </View>
    </Sheet>
  );
}

function Action({ icon, label, onPress, theme }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress(): void; theme: Theme }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.action, pressed && { opacity: 0.5 }]}>
      <Ionicons name={icon} size={24} color={theme.text} />
      <Text style={{ color: theme.text, fontSize: 12, marginTop: 4 }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 13, paddingHorizontal: 20, paddingBottom: 6 },
  textBox: { maxHeight: 260, marginHorizontal: 12 },
  textPad: { paddingHorizontal: 8, paddingBottom: 8 },
  text: { fontSize: 18, lineHeight: 28 },
  colors: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 12 },
  dot: { width: 34, height: 34, borderRadius: 17, borderWidth: 2 },
  dotBtn: { marginLeft: 'auto' },
  actions: { flexDirection: 'row', justifyContent: 'space-around', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12 },
  action: { alignItems: 'center', minWidth: 60 },
});
