import Ionicons from '@expo/vector-icons/Ionicons';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppColors } from './theme';
import { Tap } from '@/ui/Tap';

interface Action {
  label: string;
  onPress(): void;
  primary?: boolean;
}

/** Friendly full-screen error with a few ways out. */
export function ErrorScreen({ title, message, actions }: { title: string; message?: string; actions: Action[] }) {
  const c = useAppColors();
  const insets = useSafeAreaInsets();
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
      <View style={styles.actions}>
        {actions.map((a) => (
          <Tap
            key={a.label}
            onPress={a.onPress}
            style={[styles.btn, { backgroundColor: a.primary ? c.accent : c.chip }]}>
            <Text style={{ color: a.primary ? c.accentText : c.text, fontSize: 16, fontWeight: '600' }}>{a.label}</Text>
          </Tap>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  title: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  message: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  actions: { marginTop: 12, gap: 10, alignSelf: 'stretch' },
  btn: { paddingVertical: 13, borderRadius: 12, alignItems: 'center' },
});
