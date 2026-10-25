// The crash log as people see it: a note after the app was closed by an
// error, and the log itself (library → View → Crash log). Native alerts.

import { Alert } from 'react-native';
import { type Crash, clearCrashes, crashReport, takeUnseenFatal } from '@/lib/crashLog';
import { shareTextFile } from '@/lib/shareText';

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

const share = () => void shareTextFile('nec-reader-crash-log.txt', crashReport(), 'text/plain');

/** After a restart: say once that the app was closed by an error. */
export function noteLastCrash() {
  const c = takeUnseenFatal();
  if (!c) return;
  Alert.alert('The app closed because of an error', `${c.message}\n\nIt’s kept in the crash log (View menu in the library).`, [
    { text: 'Share report', onPress: share },
    { text: 'OK', style: 'cancel' },
  ]);
}

export function showCrashLog(crashes: Crash[]) {
  const latest = crashes[crashes.length - 1];
  if (!latest) return;
  const n = crashes.length;
  Alert.alert('Crash log', `${n === 1 ? '1 error' : `${n} errors`} recorded. Latest, ${when(latest.at)}:\n\n${latest.message}`, [
    { text: 'Clear', style: 'destructive', onPress: clearCrashes },
    { text: 'Share', onPress: share },
    { text: 'Close', style: 'cancel' },
  ]);
}
