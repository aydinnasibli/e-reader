// Backing up and restoring, as people see it (library → View menu). Native
// alerts; the file is saved or sent with the phone's share sheet.

import * as DocumentPicker from 'expo-document-picker';
import { Alert } from 'react-native';
import { type Backup, createBackup, readBackupFile, restoreBackup } from '@/lib/backup';
import { shareTextFile } from '@/lib/shareText';
import { dayKey } from '@/lib/stats';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const LIST_MAX = 12;

export async function backUp() {
  const backup = createBackup();
  await shareTextFile(`nec-reader-backup-${dayKey()}.json`, JSON.stringify(backup), 'application/json');
}

export async function restoreFromFile() {
  const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
  if (res.canceled || !res.assets[0]) return;
  let backup: Backup | null;
  try {
    backup = await readBackupFile(res.assets[0].uri);
  } catch {
    Alert.alert('Couldn’t read that file', 'Try saving it to the phone first, then pick it again.');
    return;
  }
  if (!backup) {
    Alert.alert('Not a backup', 'That file isn’t a backup made by this app.');
    return;
  }
  const b = backup;
  const made = b.createdAt ? ` made ${new Date(b.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}` : '';
  Alert.alert(
    'Restore this backup?',
    `A backup${made}, with ${plural(b.books.length, 'book', 'books')}. Highlights, notes and bookmarks are added to what’s here; reading places, collections and settings come back as they were.`,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Restore', onPress: () => showResult(restoreBackup(b)) },
    ],
  );
}

function showResult({ applied, waiting }: { applied: number; waiting: string[] }) {
  const done = applied ? `${plural(applied, 'book', 'books')} on this phone got ${applied === 1 ? 'its' : 'their'} highlights, notes and places back.` : '';
  if (!waiting.length) {
    Alert.alert('Backup restored', done || 'Settings and collections are back.');
    return;
  }
  const titles = waiting.slice(0, LIST_MAX).join('\n') + (waiting.length > LIST_MAX ? `\n…and ${waiting.length - LIST_MAX} more` : '');
  Alert.alert(
    'Backup restored',
    `${done ? done + '\n\n' : ''}${plural(waiting.length, 'book isn’t', 'books aren’t')} on this phone yet. Add ${waiting.length === 1 ? 'its file' : 'their files'} and ${waiting.length === 1 ? 'its' : 'their'} highlights and places come back:\n\n${titles}`,
  );
}
