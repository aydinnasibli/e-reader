import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect } from 'react';
import { ActivityIndicator, AppState, type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { canSelfUpdate, checkForUpdate, cleanOldDownloads, dismissUpdateError, installUpdate, snoozeUpdate, useUpdateState } from '@/lib/appUpdate';
import { formatBytes } from './format';
import { ProgressBar } from './ProgressBar';
import { useAppColors } from './theme';
import { Tap } from '@/ui/Tap';

/**
 * "New version available" bar at the top of the library (Android APK only),
 * also shown on the error screen. Its buttons are 44 points tall.
 */
export function UpdateBanner({ style }: { style?: StyleProp<ViewStyle> }) {
  const c = useAppColors();
  const s = useUpdateState();

  // Check on launch and whenever the app comes back to the foreground.
  useEffect(() => {
    if (!canSelfUpdate()) return;
    cleanOldDownloads();
    void checkForUpdate();
    const sub = AppState.addEventListener('change', (st) => st === 'active' && void checkForUpdate());
    return () => sub.remove();
  }, []);

  if (s.kind === 'idle') return null;

  // Only a check asked for from the menu shows this.
  if (s.kind === 'checking') {
    return (
      <View style={[styles.bar, { backgroundColor: c.card, borderColor: c.border }, style]}>
        <ActivityIndicator color={c.accent} />
        <Text style={[styles.title, styles.body, { color: c.text }]}>Checking for updates…</Text>
      </View>
    );
  }

  if (s.kind === 'error') {
    return (
      <View style={[styles.bar, { backgroundColor: c.card, borderColor: c.border }, style]}>
        <Ionicons name="alert-circle-outline" size={22} color={c.danger} />
        <View style={styles.body}>
          <Text style={[styles.title, { color: c.text }]}>Update failed</Text>
          <Text numberOfLines={2} style={{ color: c.secondary, fontSize: 13 }}>
            {s.message}
          </Text>
        </View>
        <Tap onPress={dismissUpdateError} style={styles.target}>
          <Text style={{ color: c.accent, fontWeight: '600' }}>OK</Text>
        </Tap>
      </View>
    );
  }

  const update = s.update;
  const busy = s.kind === 'downloading' || s.kind === 'installing';
  return (
    <View style={[styles.bar, { backgroundColor: c.card, borderColor: c.border }, style]}>
      <Ionicons name="cloud-download-outline" size={22} color={c.accent} />
      <View style={styles.body}>
        <Text style={[styles.title, { color: c.text }]}>
          {s.kind === 'downloading' ? `Downloading… ${Math.round(s.progress * 100)}%` : s.kind === 'installing' ? 'Opening installer…' : 'New version available'}
        </Text>
        {s.kind === 'downloading' ? (
          <ProgressBar value={s.progress} color={c.accent} track={c.border} height={4} style={styles.track} />
        ) : s.kind === 'available' && s.tried ? (
          <Text style={{ color: c.secondary, fontSize: 13 }}>
            Not installed yet. If Android asked, tap Settings, allow installing from this app, then go back and tap Update again.
          </Text>
        ) : (
          <Text numberOfLines={2} style={{ color: c.secondary, fontSize: 13 }}>
            {`Version 1.0.${update.build} · ${formatBytes(update.size)}`}
            {update.notes ? ` · ${update.notes.split('\n')[0]}` : ''}
          </Text>
        )}
      </View>
      {!busy && (
        <View style={styles.actions}>
          <Tap onPress={() => installUpdate(update)} style={styles.target} accessibilityLabel="Update">
            <View style={[styles.btn, { backgroundColor: c.accent }]}>
              <Text style={{ color: c.accentText, fontWeight: '700' }}>Update</Text>
            </View>
          </Tap>
          <Tap onPress={snoozeUpdate} style={styles.target} accessibilityLabel="Not now">
            <Text style={{ color: c.secondary, fontSize: 13 }}>Not now</Text>
          </Tap>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  body: { flex: 1, gap: 3 },
  title: { fontSize: 15, fontWeight: '700' },
  btn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  // What a finger can hit: at least 44 points around the drawn button or link.
  target: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  actions: { alignItems: 'center' },
  track: { marginTop: 4 },
});
