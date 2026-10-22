import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAppColors } from './theme';

interface Action {
  label: string;
  onPress(): void;
  primary?: boolean;
}

/** Friendly full-screen error with a few ways out. */
export function ErrorScreen({ title, message, actions }: { title: string; message?: string; actions: Action[] }) {
  const c = useAppColors();
  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <Ionicons name="alert-circle-outline" size={52} color={c.secondary} />
      <Text style={[styles.title, { color: c.text }]}>{title}</Text>
      {message ? (
        <Text style={[styles.message, { color: c.secondary }]} numberOfLines={6}>
          {message}
        </Text>
      ) : null}
      <View style={styles.actions}>
        {actions.map((a) => (
          <Pressable
            key={a.label}
            onPress={a.onPress}
            style={({ pressed }) => [styles.btn, { backgroundColor: a.primary ? c.accent : c.chip, opacity: pressed ? 0.7 : 1 }]}>
            <Text style={{ color: a.primary ? c.accentText : c.text, fontSize: 16, fontWeight: '600' }}>{a.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  title: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  message: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  actions: { marginTop: 12, gap: 10, alignSelf: 'stretch' },
  btn: { paddingVertical: 13, borderRadius: 12, alignItems: 'center' },
});
