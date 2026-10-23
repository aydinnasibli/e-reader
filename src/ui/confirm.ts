// Confirmations for deleting things that can't be brought back. Native
// alerts, so they also show over sheets.

import { Alert } from 'react-native';
import { type Highlight, getAnnotations } from '@/lib/annotations';
import { type BookEntry, deleteBook } from '@/lib/library';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What else goes when a book is removed, e.g. "its 3 highlights and 1 bookmark". */
export function annotationsSummary(bookId: string): string | null {
  const { highlights, bookmarks } = getAnnotations(bookId);
  const notes = highlights.filter((h) => h.note?.trim()).length;
  const parts = [
    highlights.length ? plural(highlights.length, 'highlight', 'highlights') + (notes ? ` (${plural(notes, 'with a note', 'with notes')})` : '') : '',
    bookmarks.length ? plural(bookmarks.length, 'bookmark', 'bookmarks') : '',
  ].filter(Boolean);
  return parts.length ? `its ${parts.join(' and ')}` : null;
}

/** `leave` runs just before the book is deleted (e.g. to close a screen showing it). */
export function confirmRemoveBook(book: BookEntry, leave?: () => void) {
  const also = annotationsSummary(book.id);
  Alert.alert('Remove book?', `"${book.title}" will be deleted from this phone${also ? `, with ${also}` : ''}. This can't be undone.`, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Remove',
      style: 'destructive',
      onPress: () => {
        leave?.();
        deleteBook(book.id);
      },
    },
  ]);
}

export const hasNote = (h: Pick<Highlight, 'note'>) => !!h.note?.trim();

export function confirmDeleteHighlight(withNote: boolean, onDelete: () => void) {
  Alert.alert(withNote ? 'Delete highlight and its note?' : 'Delete highlight?', undefined, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: onDelete },
  ]);
}
