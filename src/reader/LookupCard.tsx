// Definition or translation of the selected text, shown inside the selection
// sheet instead of a browser.

import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { getLocales } from 'expo-localization';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { type Definition, LANGUAGES, LookupError, type Translation, defineWord, languageName, translateText } from '@/lib/lookup';
import { setSettings, type Theme, useSettings } from '@/lib/settings';
import { Tap } from '@/ui/Tap';

export type LookupKind = 'define' | 'translate';

interface Props {
  kind: LookupKind;
  text: string;
  /** Language of the book, if known. */
  lang?: string;
  theme: Theme;
  /** Close the card. */
  onBack(): void;
  /** Switch between definition and translation of the same text. */
  onSwitch(kind: LookupKind): void;
}

type State<T> = { status: 'loading' } | { status: 'done'; value: T | null } | { status: 'error'; offline: boolean };

/** The language to translate into: the saved choice, else the phone's. */
export function translateTarget(saved: string): string {
  if (saved) return saved;
  const phone = getLocales()[0]?.languageCode ?? 'en';
  return LANGUAGES.find((l) => l.code.slice(0, 2) === phone)?.code ?? phone;
}

/** Show one kind of answer: the parent gives each kind its own card (`key`), so an answer is never read as the other kind. */
export function LookupCard({ kind, text, lang, theme, onBack, onSwitch }: Props) {
  const settings = useSettings();
  const to = translateTarget(settings.translateTo);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State<Definition | Translation>>({
    status: 'loading',
  });

  useEffect(() => {
    const ctl = new AbortController();
    setState({ status: 'loading' });
    const job: Promise<Definition | Translation | null> =
      kind === 'define' ? defineWord(text, lang, ctl.signal) : translateText(text, to, ctl.signal);
    job.then(
      (value) => !ctl.signal.aborted && setState({ status: 'done', value }),
      (e: unknown) => !ctl.signal.aborted && setState({ status: 'error', offline: e instanceof LookupError && e.offline }),
    );
    return () => ctl.abort();
  }, [kind, text, lang, to, attempt]);

  const muted = { color: theme.muted };
  const body = (() => {
    if (state.status === 'loading') return <ActivityIndicator style={styles.pad} color={theme.muted} />;
    if (state.status === 'error')
      return (
        <View style={styles.pad}>
          <Text style={[styles.msg, muted]}>
            {kind === 'define' ? 'Couldn’t reach the dictionary.' : 'Couldn’t translate right now.'}{' '}
            {state.offline ? 'Check the internet connection.' : 'The service didn’t answer; try again in a moment.'}
          </Text>
          <Tap onPress={() => setAttempt((a) => a + 1)} style={[styles.btn, { borderColor: theme.border }]} accessibilityLabel="Try again">
            <Text style={{ color: theme.accent, fontWeight: '600' }}>Try again</Text>
          </Tap>
        </View>
      );
    if (kind === 'define') {
      const def = state.value as Definition | null;
      if (!def)
        return (
          <View style={styles.pad}>
            <Text style={[styles.msg, muted]}>No dictionary entry for “{text}”.</Text>
            <Tap
              onPress={() => onSwitch('translate')}
              style={[styles.btn, { borderColor: theme.border }]}
              accessibilityLabel="Translate instead">
              <Text style={{ color: theme.accent, fontWeight: '600' }}>Translate instead</Text>
            </Tap>
          </View>
        );
      return (
        <>
          <Text style={[styles.word, { color: theme.text }]}>
            {def.word}
            {def.language ? <Text style={[styles.lang, muted]}>{'  ' + def.language}</Text> : null}
          </Text>
          {def.senses.map((s, i) => (
            <View key={i} style={styles.sense}>
              {s.pos ? <Text style={[styles.pos, muted]}>{s.pos.toLowerCase()}</Text> : null}
              {s.defs.map((d, j) => (
                <View key={j} style={styles.def}>
                  <Text style={[styles.num, muted]}>{j + 1}.</Text>
                  <View style={styles.flex}>
                    <Text style={[styles.defText, { color: theme.text }]}>{d.text}</Text>
                    {d.example ? <Text style={[styles.example, muted]}>{d.example}</Text> : null}
                  </View>
                </View>
              ))}
            </View>
          ))}
          <Text style={[styles.source, muted]}>From {def.source}</Text>
        </>
      );
    }
    const t = state.value as Translation;
    return (
      <>
        <Text selectable style={[styles.translation, { color: theme.text }]}>
          {t.text}
        </Text>
        {t.partial ? <Text style={[styles.source, muted]}>Only the beginning was translated. Select less text to translate the rest.</Text> : null}
        <View style={styles.row}>
          {languageName(t.from) ? (
            <Text style={[styles.source, muted]}>
              From {languageName(t.from)} · {t.source}
            </Text>
          ) : (
            <Text style={[styles.source, muted]}>{t.source}</Text>
          )}
          <Tap
            onPress={() => {
              Clipboard.setStringAsync(t.text).catch(() => {});
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
            }}
            hitSlop={10}
            accessibilityLabel="Copy translation">
            <Ionicons name="copy-outline" size={20} color={theme.muted} />
          </Tap>
        </View>
      </>
    );
  })();

  return (
    <View>
      <View style={styles.header}>
        <Tap onPress={onBack} hitSlop={12} accessibilityLabel={kind === 'define' ? 'Close dictionary' : 'Close translation'} style={styles.back}>
          <Ionicons name="close" size={22} color={theme.text} />
        </Tap>
        <Text style={[styles.title, { color: theme.text }]}>{kind === 'define' ? 'Dictionary' : 'Translation'}</Text>
        <Tap
          onPress={() => onSwitch(kind === 'define' ? 'translate' : 'define')}
          hitSlop={10}
          accessibilityLabel={kind === 'define' ? 'Show translation' : 'Show definition'}>
          <Ionicons name={kind === 'define' ? 'language-outline' : 'book-outline'} size={22} color={theme.accent} />
        </Tap>
      </View>
      {kind === 'translate' ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.langs} keyboardShouldPersistTaps="handled">
          {LANGUAGES.map((l) => {
            const on = l.code === to;
            return (
              <Tap
                key={l.code}
                haptic="select"
                onPress={() => setSettings({ translateTo: l.code })}
                accessibilityLabel={`Translate into ${l.name}`}
                accessibilityState={{ selected: on }}
                style={[
                  styles.chip,
                  {
                    borderColor: on ? theme.accent : theme.border,
                    backgroundColor: on ? theme.accent + '22' : undefined,
                  },
                ]}>
                <Text
                  style={{
                    color: on ? theme.accent : theme.text,
                    fontSize: 13,
                  }}>
                  {l.name}
                </Text>
              </Tap>
            );
          })}
        </ScrollView>
      ) : null}
      {kind === 'translate' ? (
        <Text numberOfLines={2} style={[styles.original, muted]}>
          {text}
        </Text>
      ) : null}
      <ScrollView style={styles.box} contentContainerStyle={styles.boxPad}>
        {body}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 8,
  },
  back: { padding: 2 },
  title: { flex: 1, fontSize: 17, fontWeight: '700' },
  langs: { gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  chip: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  original: {
    fontSize: 14,
    fontStyle: 'italic',
    paddingHorizontal: 20,
    paddingBottom: 6,
  },
  box: { maxHeight: 340, marginHorizontal: 8 },
  boxPad: { paddingHorizontal: 12, paddingBottom: 12 },
  pad: { paddingVertical: 24, alignItems: 'center', gap: 14 },
  msg: { fontSize: 15, textAlign: 'center' },
  btn: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  word: { fontSize: 22, fontWeight: '700', marginBottom: 4 },
  lang: { fontSize: 14, fontWeight: '400' },
  sense: { marginTop: 10 },
  pos: { fontSize: 13, fontStyle: 'italic', marginBottom: 4 },
  def: { flexDirection: 'row', gap: 6, marginBottom: 6 },
  num: { fontSize: 15, minWidth: 18 },
  flex: { flex: 1 },
  defText: { fontSize: 16, lineHeight: 22 },
  example: { fontSize: 14, fontStyle: 'italic', marginTop: 2 },
  translation: { fontSize: 18, lineHeight: 27, marginTop: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  source: { fontSize: 12, marginTop: 12 },
});
