import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CURRENT_BUILD, canSelfUpdate, checkForUpdate, useUpdateState } from '@/lib/appUpdate';
import { useAppColors } from './theme';
import { Tap } from '@/ui/Tap';
import { UpdateBanner } from '@/ui/UpdateBanner';

interface Action {
  label: string;
  onPress(): void;
  primary?: boolean;
}

interface Props {
  title: string;
  message?: string;
  actions: Action[];
  /**
   * For a crash while drawing: also offer to look for a newer version, so a
   * build that keeps crashing can still be replaced (Android APK only).
   */
  offerUpdate?: boolean;
}

/** Friendly full-screen error with a few ways out. */
export function ErrorScreen({ title, message, actions, offerUpdate }: Props) {
  const c = useAppColors();
  const insets = useSafeAreaInsets();
  const update = useUpdateState();
  const canUpdate = !!offerUpdate && canSelfUpdate();
  // A check found nothing newer.
  const [latest, setLatest] = useState(false);
  const check = async () => {
    setLatest(false);
    // A newer build, progress and failures show in the update bar.
    setLatest((await checkForUpdate(true)) === 'none');
  };
  return (
    // Scrolls when it doesn't fit (a phone on its side, large text), clear of the notch.
    <ScrollView
      style={{ backgroundColor: c.bg }}
      contentContainerStyle={[
        styles.root,
        { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 32, paddingLeft: insets.left + 32, paddingRight: insets.right + 32 },
      ]}>
      <Ionicons name="alert-circle-outline" size={52} color={c.secondary} />
      <Text style={[styles.title, { color: c.text }]}>{title}</Text>
      {message ? (
        <Text style={[styles.message, { color: c.secondary }]} numberOfLines={6}>
          {message}
        </Text>
      ) : null}
      {canUpdate ? <UpdateBanner style={styles.update} /> : null}
      <View style={styles.actions}>
        {actions.map((a) => (
          <Tap
            key={a.label}
            onPress={a.onPress}
            style={[styles.btn, { backgroundColor: a.primary ? c.accent : c.chip }]}>
            <Text style={{ color: a.primary ? c.accentText : c.text, fontSize: 16, fontWeight: '600' }}>{a.label}</Text>
          </Tap>
        ))}
        {canUpdate && (update.kind === 'idle' || update.kind === 'error') ? (
          <Tap onPress={() => void check()} style={[styles.btn, { backgroundColor: c.chip }]}>
            <Text style={{ color: c.text, fontSize: 16, fontWeight: '600' }}>Check for updates</Text>
          </Tap>
        ) : null}
      </View>
      {canUpdate && latest && update.kind === 'idle' ? (
        <Text style={[styles.message, { color: c.secondary }]}>{`This is the latest version (1.0.${CURRENT_BUILD}).`}</Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  title: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  message: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  update: { alignSelf: 'stretch', marginHorizontal: 0, marginBottom: 0, marginTop: 12 },
  actions: { marginTop: 12, gap: 10, alignSelf: 'stretch' },
  btn: { paddingVertical: 13, borderRadius: 12, alignItems: 'center' },
});
