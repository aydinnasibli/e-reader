import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useColorScheme } from 'react-native';
import { loadLibrary } from '@/lib/library';

loadLibrary();

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="index" options={{ title: 'Library' }} />
        {/* No swipe-back: horizontal swipes turn pages in the reader. */}
        <Stack.Screen name="reader/[id]" options={{ headerShown: false, gestureEnabled: false, fullScreenGestureEnabled: false }} />
      </Stack>
    </ThemeProvider>
  );
}
