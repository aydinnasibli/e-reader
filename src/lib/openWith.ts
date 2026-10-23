// "Open with" on Android: a book file tapped in WhatsApp, Telegram, Files,
// Gmail... arrives as a content:// (or file://) URL through Expo Router's
// +native-intent. The app shows the library, adds the book (or finds it
// already on the shelf) and opens it in the reader.
//
// redirectSystemPath sees every such URL exactly once, both the one that
// started the app and later ones while it runs, so that is the only entry
// point. iOS doesn't register as a handler for book files, and Expo Go has
// no intent filters, so nothing arrives there.

import { router } from 'expo-router';
import { useEffect } from 'react';
import { Alert } from 'react-native';
import { importSharedFile } from './library';

/** A file handed over by another app, rather than a link into this one. */
export function isSharedFileUrl(url: string): boolean {
  return /^(content|file):\/\//i.test(url);
}

// Navigating before the root navigator is mounted throws, and a file opened
// from another app can be copied before the first screen is up.
let markReady: () => void;
const navigationReady = new Promise<void>((resolve) => (markReady = resolve));

/** Called by the root layout once it is mounted: shared books can be opened from then on. */
export function useSharedFileNavigation() {
  useEffect(() => markReady(), []);
}

const inFlight = new Set<string>();

/** Add and open a shared file, telling the user if it isn't a book. Never throws. */
export async function openSharedFile(url: string): Promise<void> {
  if (inFlight.has(url)) return;
  inFlight.add(url);
  try {
    const res = await importSharedFile(url).catch(() => ({ failed: true }) as const);
    await navigationReady;
    if ('book' in res) router.push({ pathname: '/reader/[id]', params: { id: res.book.id } });
    else if ('unsupported' in res) {
      Alert.alert('This file isn’t a book the app can open', 'Books can be EPUB, FB2, MOBI, AZW3 or TXT files.');
    } else {
      Alert.alert('Couldn’t open this file', 'The app it came from may not allow reading it, or there isn’t enough free space.');
    }
  } finally {
    inFlight.delete(url);
  }
}
