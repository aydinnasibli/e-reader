// "Open with" on Android: a book file tapped in WhatsApp, Telegram, Files,
// Gmail... arrives as a content:// (or file://) URL through Expo Router's
// +native-intent. The app adds the book (or finds it already on the shelf)
// and opens it in the reader.
//
// redirectSystemPath sees every such URL once, both the one that started
// the app and later ones while it runs, so that is the only entry point.
// iOS doesn't register as a handler for book files, and Expo Go has no
// intent filters, so nothing arrives there.

import { File, Paths } from 'expo-file-system';
import { router } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';
import { Alert } from 'react-native';
import { getBook, importSharedFile, loadLibrary } from './library';
import { readJson, saveJson } from './storage';

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

const launchFile = () => new File(Paths.document, 'launch.json');

/**
 * The book a file that started the app became, if this same file started it
 * before. Android keeps the intent that launched the app and gives it again
 * when the app, killed in the background, is brought back from recent apps,
 * by which time the app it came from may no longer let it be read. So the
 * book is opened as it is on the shelf, without reading the file again. (The
 * same goes for opening that very file again later: it is the same book.)
 */
function launchedBefore(url: string): string | null {
  loadLibrary(); // this can run before the app has loaded it
  const last = readJson<{ url: string; bookId: string }>(launchFile());
  return last?.url === url && getBook(last.bookId) ? last.bookId : null;
}

const inFlight = new Set<string>();
const listeners = new Set<() => void>();

function setInFlight(url: string, adding: boolean) {
  if (adding) inFlight.add(url);
  else inFlight.delete(url);
  listeners.forEach((l) => l());
}

/** True while a shared file is being added, for the library to say so. */
export function useAddingSharedFile(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => inFlight.size > 0,
  );
}

/**
 * Add and open a shared file, telling the user if it isn't a book. `initial`:
 * the file started the app. Never throws.
 */
export async function openSharedFile(url: string, initial = false): Promise<void> {
  if (inFlight.has(url)) return;
  const known = initial ? launchedBefore(url) : null;
  if (known) {
    await navigationReady;
    router.push({ pathname: '/reader/[id]', params: { id: known } });
    return;
  }
  setInFlight(url, true);
  try {
    const res = await importSharedFile(url).catch(() => ({ failed: true }) as const);
    if (initial && 'book' in res) saveJson(launchFile(), { url, bookId: res.book.id });
    await navigationReady;
    // A book that failed to prepare before opens too: the reader explains and offers to try again.
    if ('book' in res) router.push({ pathname: '/reader/[id]', params: { id: res.book.id } });
    else if ('unsupported' in res) {
      Alert.alert('This file isn’t a book the app can open', 'Books can be EPUB, FB2, MOBI, AZW3 or TXT files.');
    } else {
      Alert.alert('Couldn’t open this file', 'The app it came from may not allow reading it, or there isn’t enough free space.');
    }
  } finally {
    setInFlight(url, false);
  }
}
