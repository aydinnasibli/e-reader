// When a book counts as read. Most books don't end on their last page: notes,
// acknowledgements, "about the author" or a preview of another book follow
// the story, and readers stop before them. So a book is finished on turning
// pages onto its last page, or from the story into the back matter that ends
// it (not by jumping there, e.g. to read a note).

import type { TocEntry } from '@/engine/types';

// Titles of back matter, in the languages the app is used with. Matched
// against a whole contents entry (case-insensitive, trailing punctuation ignored).
const BACK_MATTER = new RegExp(
  '^(?:' +
    [
      // English
      'notes?',
      'end ?notes',
      'foot ?notes',
      'acknowledge?ments?',
      'about the authors?',
      'about the translators?',
      'also by .*',
      'other (?:books|titles|works) by .*',
      'books by .*',
      'bibliography',
      'references',
      'sources',
      'further reading',
      'index',
      'glossary',
      'copyright',
      'credits',
      'colophon',
      'praise for .*',
      'reading group guide',
      'discussion questions',
      '(?:a )?(?:preview|sneak peek|excerpt)(?: .*)?',
      // Russian
      'примечани[ея]',
      'комментари[ий]',
      'сноски',
      'об авторе',
      'благодарност[иь]',
      'библиография',
      'список литературы',
      'литература',
      'указатель',
      'словарь',
      'содержание',
      'оглавление',
      // Azerbaijani, Turkish
      'qeydlər',
      'izahlar',
      'müəllif haqqında',
      'təşəkkür(?:lər)?',
      'mündəricat',
      'notlar',
      'dipnotlar',
      'yazar hakkında',
      'teşekkür(?:ler)?',
      'kaynakça',
      'dizin',
      'içindekiler',
    ].join('|') +
    ')$',
  'iu',
);

export function isBackMatter(title: string): boolean {
  return BACK_MATTER.test(title.trim().replace(/[\s.:;!*]+$/u, ''));
}

/**
 * First block of the back matter at the end of the book, or null if it
 * doesn't end with any. Entries nested under a back matter entry ("Notes" ›
 * "Chapter 1") belong to it. Only trusted in the second half of the book's
 * text (`charAt` gives a block's position in characters, roughly), so a stray
 * "Notes" near the start never ends it early.
 */
export function storyEnd(toc: TocEntry[], charAt: (b: number) => number, totalChars: number): number | null {
  // The run of back matter entries that lasts to the end of the contents.
  let start: TocEntry | null = null;
  for (const t of toc) {
    if (start && t.l > start.l) continue; // nested under it
    if (isBackMatter(t.t)) start ??= t;
    else start = null;
  }
  return start && charAt(start.b) >= totalChars / 2 ? start.b : null;
}

export interface Step {
  /** Where reading started since the last jump (block), or null right after one. */
  runStart: number | null;
  /** Block of the page shown before, and now. */
  prev: number;
  now: number;
  /** A page turn arrived at the book's last page (not a layout change showing it). */
  turnedToLast: boolean;
  /** First block of the back matter, if the book has any (see storyEnd). */
  storyEnd: number | null;
}

/**
 * Whether this move finishes the book: turning pages, in a stretch of
 * reading that started in the story, onto the last page or across into the
 * back matter.
 */
export function finishesBook(s: Step): boolean {
  if (s.runStart === null) return false; // a jump
  if (s.storyEnd !== null && s.runStart >= s.storyEnd) return false; // reading notes, not the story
  if (s.turnedToLast) return true;
  return s.storyEnd !== null && s.prev < s.storyEnd && s.now >= s.storyEnd;
}
