// The phone's own bars while reading: the status bar, Android's navigation
// bar and the iPhone's home indicator are out of the way, and come back with
// the menu. Hidden, Android's navigation bar comes back for a moment with a
// swipe from the edge, and the back gesture still works.

import { NavigationBar } from 'expo-navigation-bar';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export function SystemBars({ shown, dark }: { shown: boolean; dark: boolean }) {
  // Light icons on a dark page, dark ones on a light page.
  const style = dark ? 'light' : 'dark';
  return (
    <>
      <Stack.Screen options={{ autoHideHomeIndicator: !shown }} />
      <StatusBar hidden={!shown} style={style} />
      <NavigationBar hidden={!shown} style={style} />
    </>
  );
}
