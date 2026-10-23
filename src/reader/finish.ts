// When a book counts as read. Most books don't end on their last page: notes,
// acknowledgements, "about the author" or a preview of another book follow
// the story, and readers stop before them. So a book is finished on reaching
// either its last page or, by turning pages, the back matter that ends it.

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
 * doesn't end with any. Only trusted in the second half of the book, so a
 * stray "Notes" at the start (a preface's notes) never ends it early.
 */
export function storyEnd(toc: TocEntry[], totalBlocks: number): number | null {
  let end: number | null = null;
  for (let i = toc.length - 1; i >= 0 && isBackMatter(toc[i].t); i--) end = toc[i].b;
  return end !== null && end >= totalBlocks / 2 ? end : null;
}
