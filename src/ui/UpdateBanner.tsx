import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { canSelfUpdate, checkForUpdate, dismissUpdateError, installUpdate, useUpdateState } from '@/lib/appUpdate';
import { formatBytes } from './format';
import { useAppColors } from './theme';

/** "New version available" bar at the top of the library (Android APK only). */
export function UpdateBanner() {
  const c = useAppColors();
  const s = useUpdateState();

  // Check on launch and whenever the app comes back to the foreground.
  useEffect(() => {
    if (!canSelfUpdate()) return;
    void checkForUpdate();
    const sub = AppState.addEventListener('change', (st) => st === 'active' && void checkForUpdate());
    return () => sub.remove();
  }, []);

  if (s.kind === 'idle' || s.kind === 'checking') return null;

  if (s.kind === 'error') {
    return (
      <View style={[styles.bar, { backgroundColor: c.card, borderColor: c.border }]}>
        <Ionicons name="alert-circle-outline" size={22} color={c.danger} />
        <View style={styles.body}>
          <Text style={[styles.title, { color: c.text }]}>Update failed</Text>
          <Text numberOfLines={2} style={{ color: c.secondary, fontSize: 13 }}>
            {s.message}
          </Text>
        </View>
        <Pressable onPress={dismissUpdateError} hitSlop={10}>
          <Text style={{ color: c.accent, fontWeight: '600' }}>OK</Text>
        </Pressable>
      </View>
    );
  }

  const update = s.update;
  const busy = s.kind === 'downloading' || s.kind === 'installing';
  return (
    <View style={[styles.bar, { backgroundColor: c.card, borderColor: c.border }]}>
      <Ionicons name="cloud-download-outline" size={22} color={c.accent} />
      <View style={styles.body}>
        <Text style={[styles.title, { color: c.text }]}>
          {s.kind === 'downloading' ? `Downloading… ${Math.round(s.progress * 100)}%` : s.kind === 'installing' ? 'Opening installer…' : 'New version available'}
        </Text>
        {s.kind === 'downloading' ? (
          <View style={[styles.track, { backgroundColor: c.border }]}>
            <View style={[styles.fill, { width: `${Math.round(s.progress * 100)}%`, backgroundColor: c.accent }]} />
          </View>
        ) : (
          <Text numberOfLines={2} style={{ color: c.secondary, fontSize: 13 }}>
            {`Version 1.0.${update.build} · ${formatBytes(update.size)}`}
            {update.notes ? ` · ${update.notes.split('\n')[0]}` : ''}
          </Text>
        )}
      </View>
      {!busy && (
        <Pressable onPress={() => installUpdate(update)} style={[styles.btn, { backgroundColor: c.accent }]}>
          <Text style={{ color: c.accentText, fontWeight: '700' }}>Update</Text>
        </Pressable>
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
  track: { height: 4, borderRadius: 2, overflow: 'hidden', marginTop: 4 },
  fill: { height: 4 },
});
