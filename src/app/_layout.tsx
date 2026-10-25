import { DarkTheme, DefaultTheme, type ErrorBoundaryProps, Stack, ThemeProvider, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ErrorScreen } from '@/ui/ErrorScreen';
import { AppState } from 'react-native';
import { flushAnnotations } from '@/lib/annotations';
import { installCrashHandlers, setCrashScreen, useRecordScreenError } from '@/lib/crashLog';
import { flushLibrary, loadLibrary } from '@/lib/library';
import { migrateStorage } from '@/lib/migrations';
import { useSharedFileNavigation } from '@/lib/openWith';
import { flushStats } from '@/lib/stats';
import { noteLastCrash } from '@/ui/crashDialogs';
import { DialogHost } from '@/ui/dialogs';
import { useAppColors } from '@/ui/theme';

function savePending() {
  flushLibrary();
  flushStats();
  flushAnnotations();
}

// First, so that an error while starting is recorded too; an error that is
// about to close the app saves what's pending first.
installCrashHandlers(savePending);
migrateStorage();
loadLibrary();
// The app may be killed any time it's in the background: save what's pending.
// Deferred a tick so other screens (the reader saving its position) go first.
AppState.addEventListener('change', (s) => {
  if (s !== 'active') Promise.resolve().then(savePending);
});

export default function RootLayout() {
  const c = useAppColors();
  useSharedFileNavigation();
  const path = usePathname();
  useEffect(() => setCrashScreen(path), [path]);
  useEffect(noteLastCrash, []);
  const base = c.dark ? DarkTheme : DefaultTheme;
  return (
    <ThemeProvider value={{ ...base, colors: { ...base.colors, background: c.bg, card: c.bg, text: c.text, primary: c.accent, border: c.border } }}>
      <Stack>
        <Stack.Screen name="index" options={{ title: 'Library' }} />
        {/* No swipe-back: horizontal swipes turn pages in the reader. */}
        <Stack.Screen name="reader/[id]" options={{ headerShown: false, gestureEnabled: false, fullScreenGestureEnabled: false }} />
      </Stack>
      <DialogHost />
      {/* Dark icons on light screens and light ones on dark (the reader sets its own). */}
      <StatusBar style={c.dark ? 'light' : 'dark'} />
    </ThemeProvider>
  );
}

/** Shown instead of a blank screen if something crashes while drawing. */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useRecordScreenError(error);
  return <ErrorScreen title="Something went wrong" message={error.message} actions={[{ label: 'Try again', onPress: retry, primary: true }]} />;
}
