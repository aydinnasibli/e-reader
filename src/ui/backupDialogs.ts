// Backing up and restoring, as people see it (library → View menu). Native
// alerts; the file is saved or sent with the phone's share sheet.

import * as DocumentPicker from 'expo-document-picker';
import { Alert } from 'react-native';
import { type Backup, BackupTooBig, type RestoreResult, createBackupReport, readBackupFile, restoreBackup } from '@/lib/backup';
import { shareTextFile } from '@/lib/shareText';
import { dayKey } from '@/lib/stats';
import { formatLongDate, plural } from '@/ui/format';
const LIST_MAX = 12;
const listOf = (titles: string[]) => titles.slice(0, LIST_MAX).join('\n') + (titles.length > LIST_MAX ? `\n…and ${titles.length - LIST_MAX} more` : '');

/** Make a backup and hand it to the share sheet; never throws (it runs from a menu). */
export async function backUp() {
  let skipped: string[];
  try {
    const made = await createBackupReport();
    skipped = made.skipped;
    // Only as a file: sent as message text, it couldn't be picked to be restored.
    await shareTextFile(`nec-reader-backup-${dayKey()}.json`, JSON.stringify(made.backup), 'application/json', { textFallback: false });
  } catch {
    Alert.alert('Couldn’t make the backup', 'Try again in a moment. If the phone is nearly full, free some space first.');
    return;
  }
  if (skipped.length) {
    Alert.alert(
      plural(skipped.length, 'book isn’t', 'books aren’t') + ' in the backup',
      `${skipped.length === 1 ? 'Its file is' : 'Their files are'} missing from this phone, so another phone couldn’t tell which book ${skipped.length === 1 ? 'it is' : 'they are'}. Add ${skipped.length === 1 ? 'its file' : 'their files'} again, then back up again to include ${skipped.length === 1 ? 'its' : 'their'} highlights and notes:\n\n${listOf(skipped)}`,
    );
  }
}

export async function restoreFromFile() {
  let res: DocumentPicker.DocumentPickerResult;
  try {
    // Read where it is (no copy made by the picker on Android's UI thread); a file far bigger than a backup isn't read at all.
    res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: false });
  } catch {
    Alert.alert('Couldn’t open the file picker', 'Please try again in a moment.');
    return;
  }
  if (res.canceled || !res.assets[0]) return;
  let backup: Backup | null;
  try {
    backup = await readBackupFile(res.assets[0].uri, res.assets[0].size ?? undefined);
  } catch (e) {
    if (e instanceof BackupTooBig) Alert.alert('Not a backup', 'That file is far too big to be a backup made by this app.');
    else Alert.alert('Couldn’t read that file', 'Try saving it to the phone first, then pick it again.');
    return;
  }
  if (!backup) {
    Alert.alert('Not a backup', 'That file isn’t a backup made by this app.');
    return;
  }
  const b = backup;
  const made = b.createdAt ? ` made ${formatLongDate(b.createdAt)}` : '';
  Alert.alert(
    'Restore this backup?',
    `A backup${made}, with ${plural(b.books.length, 'book', 'books')}. Highlights, notes and bookmarks are added to what’s here; reading places, collections and settings come back as they were.`,
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Restore',
        // An error thrown from an alert's button closes the app: caught here.
        onPress: () => {
          try {
            showResult(restoreBackup(b));
          } catch {
            Alert.alert('Couldn’t restore the backup', 'There may not be enough free space on this phone. Free some up, then restore it again: nothing is added twice.');
          }
        },
      },
    ],
  );
}

function showResult({ applied, waiting, failed }: RestoreResult) {
  if (failed.length) {
    Alert.alert(
      'Not everything was restored',
      `There isn’t enough free space on this phone to keep the highlights and places of:\n\n${listOf(failed)}\n\nFree some up, then restore the backup again: nothing is added twice.`,
    );
    return;
  }
  const done = applied ? `${plural(applied, 'book', 'books')} on this phone got ${applied === 1 ? 'its' : 'their'} highlights, notes and places back.` : '';
  if (!waiting.length) {
    Alert.alert('Backup restored', done || 'Settings and collections are back.');
    return;
  }
  Alert.alert(
    'Backup restored',
    `${done ? done + '\n\n' : ''}${plural(waiting.length, 'book isn’t', 'books aren’t')} on this phone yet. Add ${waiting.length === 1 ? 'its file' : 'their files'} and ${waiting.length === 1 ? 'its' : 'their'} highlights and places come back:\n\n${listOf(waiting)}`,
  );
}
