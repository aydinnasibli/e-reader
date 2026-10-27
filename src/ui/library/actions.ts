// What the library's books, chips and buttons do: open a book, the menus of a
// book, a collection and the View button, and adding books from the phone.
// A book's own actions read the shelves when they run, so each cell can be
// handed the same functions and isn't drawn again for new ones.

import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Alert } from 'react-native';
import { CURRENT_BUILD, canSelfUpdate, checkForUpdate } from '@/lib/appUpdate';
import {
  type Filter,
  SORT_LABELS,
  type SortKey,
  createCollection,
  deleteCollection,
  getShelves,
  isFinished,
  renameCollection,
  setSort,
  setView,
  toggleInCollection,
  useShelves,
} from '@/lib/collections';
import { useCrashes } from '@/lib/crashLog';
import { type BookEntry, importBooks, reprocessBook, updateBook } from '@/lib/library';
import { backUp, restoreFromFile } from '@/ui/backupDialogs';
import { confirmRemoveBook } from '@/ui/confirm';
import { showCrashLog } from '@/ui/crashDialogs';
import { showActions, showPrompt } from '@/ui/dialogs';
import { pushOnce } from '@/ui/navigate';

/** Open a book in the reader; one that failed to prepare says why, with what can be done. */
export function openBook(b: BookEntry) {
  if (b.status === 'error') {
    Alert.alert("Couldn't open this book", b.error ?? 'Unknown error', [
      { text: 'OK', style: 'cancel' },
      // The usual confirmation: it says what else goes (highlights, notes).
      { text: 'Remove', style: 'destructive', onPress: () => confirmRemoveBook(b) },
      { text: 'Try again', onPress: () => reprocessBook(b.id) },
    ]);
    return;
  }
  pushOnce({ pathname: '/reader/[id]', params: { id: b.id } });
}

export function newCollection(then?: (id: string) => void) {
  showPrompt('New collection', { placeholder: 'Name', confirm: 'Create', onSubmit: (name) => then?.(createCollection(name).id) });
}

/** A book's menu (long press). */
export function bookMenu(b: BookEntry) {
  Haptics.selectionAsync().catch(() => {});
  const finished = isFinished(b);
  showActions(b.title, [
    { label: 'Details', icon: 'information-circle-outline', onPress: () => pushOnce({ pathname: '/book/[id]', params: { id: b.id } }) },
    { label: 'Add to collection…', icon: 'albums-outline', onPress: () => collectionsMenu(b) },
    {
      label: finished ? 'Mark as unread' : 'Mark as finished',
      icon: finished ? 'book-outline' : 'checkmark-done-outline',
      onPress: () => updateBook(b.id, { finished: !finished }),
    },
    {
      label: 'Remove from library',
      icon: 'trash-outline',
      destructive: true,
      onPress: () => confirmRemoveBook(b),
    },
  ]);
}

function collectionsMenu(b: BookEntry) {
  showActions('Collections', [
    ...getShelves().collections.map((col) => ({
      label: col.name,
      icon: 'albums-outline' as const,
      checked: b.collections?.includes(col.id),
      onPress: () => toggleInCollection(b.id, col.id),
    })),
    { label: 'New collection…', icon: 'add', onPress: () => newCollection((id) => toggleInCollection(b.id, id)) },
  ]);
}

/** The View button's menu, and a collection chip's menu (long press). */
export function useLibraryMenus(books: BookEntry[], filter: Filter, setFilter: (f: Filter) => void) {
  const shelves = useShelves();
  const crashes = useCrashes();

  const viewMenu = () =>
    showActions('View', [
      { label: 'Grid', icon: 'grid-outline', checked: shelves.view === 'grid', onPress: () => setView('grid') },
      { label: 'List', icon: 'list-outline', checked: shelves.view === 'list', onPress: () => setView('list') },
      ...(Object.keys(SORT_LABELS) as SortKey[]).map((k) => ({
        label: `Sort by ${SORT_LABELS[k].toLowerCase()}`,
        icon: 'swap-vertical-outline' as const,
        checked: shelves.sort === k,
        onPress: () => setSort(k),
      })),
      ...(canSelfUpdate()
        ? [
            {
              label: `Check for updates (you have 1.0.${CURRENT_BUILD})`,
              icon: 'cloud-download-outline' as const,
              onPress: async () => {
                const r = await checkForUpdate(true);
                // A newer build shows the update bar; failures show there too.
                if (r === 'none') Alert.alert('Up to date', `You have the latest version (1.0.${CURRENT_BUILD}).`);
              },
            },
          ]
        : []),
      { label: 'Back up highlights & notes', icon: 'share-outline', onPress: () => void backUp() },
      { label: 'Restore a backup…', icon: 'arrow-undo-outline', onPress: () => void restoreFromFile() },
      ...(crashes.length ? [{ label: `Crash log (${crashes.length})`, icon: 'bug-outline' as const, onPress: () => showCrashLog(crashes) }] : []),
    ]);

  const collectionMenu = (id: string, name: string) =>
    showActions(name, [
      { label: 'Rename', icon: 'pencil-outline', onPress: () => showPrompt('Rename collection', { initial: name, onSubmit: (n) => renameCollection(id, n) }) },
      {
        label: 'Delete collection',
        icon: 'trash-outline',
        destructive: true,
        onPress: () =>
          Alert.alert('Delete collection?', `"${name}" will be deleted. The books in it stay in your library.`, [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete',
              style: 'destructive',
              onPress: () => {
                deleteCollection(id, books);
                if (filter.kind === 'collection' && filter.id === id) setFilter({ kind: 'all' });
              },
            },
          ]),
      },
    ]);

  return { viewMenu, collectionMenu };
}

/** The Add button: the phone's file picker, then what couldn't be added, and why. */
export function useAddBooks() {
  const [importing, setImporting] = useState(false);
  const add = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const res = await importBooks();
      if (res.failed.length) Alert.alert("Couldn't add some books", `There isn't enough free space on this phone:\n\n${res.failed.join('\n')}`);
      // Anything else that went wrong is in the crash log.
      if (res.other.length) Alert.alert("Couldn't add some books", `Something went wrong; the crash log has the details (View menu):\n\n${res.other.join('\n')}`);
      // Picked from a cloud app or service that wouldn't let this app read them.
      if (res.unreadable.length) {
        Alert.alert(
          "Couldn't read some files",
          `The app or service they're in didn't let this app read them. Save them to the phone (Files or Downloads) and add them from there:\n\n${res.unreadable.join('\n')}`,
        );
      }
      if (res.skipped.length) Alert.alert('Some files were skipped', `Supported formats: EPUB, FB2, MOBI, AZW3 and TXT:\n\n${res.skipped.join('\n')}`);
      if (res.duplicates.length) {
        const list = res.duplicates.map(([file, title]) => (file === title || !title ? file : `${file} — “${title}”`)).join('\n');
        Alert.alert('Already in your library', `Not added again:\n\n${list}`);
      }
    } catch (e) {
      Alert.alert('Import failed', e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };
  return { importing, add };
}
