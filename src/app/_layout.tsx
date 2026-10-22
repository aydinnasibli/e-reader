import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { loadLibrary } from '@/lib/library';
import { DialogHost } from '@/ui/dialogs';
import { useAppColors } from '@/ui/theme';

loadLibrary();

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
