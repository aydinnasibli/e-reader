import Ionicons from '@expo/vector-icons/Ionicons';
import { useFonts } from 'expo-font';
import { NavigationBar } from 'expo-navigation-bar';
import { DarkTheme, DefaultTheme, type ErrorBoundaryProps, Stack, ThemeProvider, usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
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
// The splash screen stays up until the icons' font has loaded: without it
// every icon is blank for the first moments. (Asked for here, as the app
// starts, or it may already have gone.)
SplashScreen.preventAutoHideAsync().catch(() => {});
/** The longest the splash screen waits for that font. */
const SPLASH_MAX_MS = 3000;
const hideSplash = () => SplashScreen.hideAsync().catch(() => {});
migrateStorage();
loadLibrary();
// The app may be killed any time it's in the background: save what's pending.
// Deferred a tick so other screens (the reader saving its position) go first.
AppState.addEventListener('change', (s) => {
  if (s !== 'active') Promise.resolve().then(savePending);
});

export default function RootLayout() {
  const c = useAppColors();
  // The screens are drawn under the splash screen meanwhile (opening a book
  // shared from another app needs the navigator from the start).
  const [iconsLoaded, iconsFailed] = useFonts(Ionicons.font);
  useEffect(() => {
    if (iconsLoaded || iconsFailed) hideSplash();
  }, [iconsLoaded, iconsFailed]);
  useEffect(() => {
    const t = setTimeout(hideSplash, SPLASH_MAX_MS);
    return () => clearTimeout(t);
  }, []);
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
      {/* Android's navigation bar likewise: without it, once the reader closes, it goes back to light buttons on any screen. */}
      <NavigationBar style={c.dark ? 'light' : 'dark'} />
    </ThemeProvider>
  );
}

/**
 * Shown instead of a blank screen if something crashes while drawing. A
 * build that crashes like this can still update itself from here.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useRecordScreenError(error);
  return <ErrorScreen title="Something went wrong" message={error.message} actions={[{ label: 'Try again', onPress: retry, primary: true }]} offerUpdate />;
}
