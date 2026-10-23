// Expo Router hands every URL the app is opened with to this function first
// (see src/lib/openWith.ts). A book file shared from another app isn't a
// route: show the library while it's added, then the reader opens it.

import { Platform } from 'react-native';
import { isSharedFileUrl, openSharedFile } from '@/lib/openWith';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  if (Platform.OS === 'android' && isSharedFileUrl(path)) {
    openSharedFile(path).catch(() => {});
    return '/';
  }
  return path;
}
