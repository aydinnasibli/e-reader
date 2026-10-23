// Expo Router hands every URL the app is opened with to this function first
// (see src/lib/openWith.ts). A book file shared from another app isn't a
// route: it's added, then the reader opens it.

import { Platform } from 'react-native';
import { isSharedFileUrl, openSharedFile } from '@/lib/openWith';

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  if (Platform.OS === 'android' && isSharedFileUrl(path)) {
    openSharedFile(path, initial).catch(() => {});
    // Starting up: the library is the first screen. Already running: stay on
    // the current screen (null), so an open book isn't closed for a file
    // that may turn out not to be a book.
    return initial ? '/' : null;
  }
  return path;
}
