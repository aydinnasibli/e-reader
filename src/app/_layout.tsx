import { DarkTheme, DefaultTheme, type ErrorBoundaryProps, Stack, ThemeProvider } from 'expo-router';
import { ErrorScreen } from '@/ui/ErrorScreen';
import { Platform } from 'react-native';
import { loadLibrary } from '@/lib/library';
import { DialogHost } from '@/ui/dialogs';
import { useAppColors } from '@/ui/theme';

// Phones only: the library lives in the app's files (web builds just render the shell).
if (Platform.OS !== 'web') loadLibrary();

export default function RootLayout() {
  const c = useAppColors();
  const base = c.dark ? DarkTheme : DefaultTheme;
  return (
    <ThemeProvider value={{ ...base, colors: { ...base.colors, background: c.bg, card: c.bg, text: c.text, primary: c.accent, border: c.border } }}>
      <Stack>
        <Stack.Screen name="index" options={{ title: 'Library' }} />
        {/* No swipe-back: horizontal swipes turn pages in the reader. */}
        <Stack.Screen name="reader/[id]" options={{ headerShown: false, gestureEnabled: false, fullScreenGestureEnabled: false }} />
      </Stack>
      <DialogHost />
    </ThemeProvider>
  );
}

/** Shown instead of a blank screen if something crashes while drawing. */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorScreen title="Something went wrong" message={error.message} actions={[{ label: 'Try again', onPress: retry, primary: true }]} />;
}
