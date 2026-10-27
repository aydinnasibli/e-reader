// The book the reader screen shows: read once (its manifest, or what's been
// converted so far), kept in step while it's still being converted, marked
// open for as long as it's read, where it opens, and its language, worked out
// before anything is drawn.

import { useEffect, useMemo, useRef, useState } from 'react';
import { normaliseLanguage } from '@/engine/language';
import type { Position } from '@/engine/types';
import { getBook, loadManifest, setBookOpen, useBookStatus, useLiveBook } from '@/lib/library';
import { BookData } from './book';

/** `atB`/`atO`: open at that place instead of where reading left off (from the highlights screen). */
export function useReaderBook(id: string, atB?: string, atO?: string) {
  const status = useBookStatus(id);
  const live = useLiveBook(id);

  // The library doesn't swap in a book converted again while it's open here.
  // It's marked open before its manifest is read: a swap in between would
  // leave the reader with the old manifest over the new chunks (and its saves
  // would put an old place over the one moved to the new blocks).
  const opened = useRef<string | null>(null);
  const book = useMemo(() => {
    const entry = getBook(id);
    if (!entry) return null;
    if (opened.current !== id) {
      setBookOpen(id, true);
      opened.current = id;
    }
    const b = new BookData(entry);
    if (entry.status === 'ready') {
      const m = loadManifest(id);
      if (m) b.setManifest(m);
    }
    return b;
  }, [id]);
  useEffect(() => () => book?.close(), [book]);
  useEffect(() => {
    if (book && opened.current !== id) {
      setBookOpen(id, true);
      opened.current = id;
    }
    return () => {
      if (opened.current) setBookOpen(opened.current, false);
      opened.current = null;
    };
  }, [id, book]);

  // Keep the book in sync while it is still converting, and when it finishes.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (book && live) {
      book.setLive(live);
      setVersion((v) => v + 1);
    }
  }, [book, live]);
  // The moment conversion finishes, take the manifest during this render (not
  // in an effect), so the damaged-book check never sees a finished book
  // without it and the reader isn't torn down and rebuilt.
  if (book && status === 'ready' && !book.complete) {
    const m = loadManifest(id);
    if (m) book.setManifest(m);
  }
  useEffect(() => {
    if (status === 'ready') setVersion((v) => v + 1);
  }, [status]);

  const savedPos = useMemo<Position>(() => getBook(id)?.position ?? { b: 0, o: 0 }, [id]);
  const startPos = useMemo<Position>(() => (atB !== undefined ? { b: Number(atB) || 0, o: Number(atO) || 0 } : savedPos), [savedPos, atB, atO]);

  // The book's language: set by hand in Book details, or the book's own. A
  // book converted before languages were worked out has neither: it's told
  // from the text before anything is drawn (hyphenation and the page's text
  // depend on it, and must not change under the reader).
  const [guessedLang, setGuessedLang] = useState<string | null | undefined>(undefined);
  const ownLang = normaliseLanguage(getBook(id)?.lang ?? book?.manifest?.lang);
  const lang = ownLang ?? guessedLang ?? undefined;
  const needGuess = !!book && !ownLang && guessedLang === undefined;
  const canGuess = !!book && book.chunkCount > 0;
  useEffect(() => {
    if (!needGuess || !canGuess || !book) return;
    let alive = true;
    book.guessLanguage(startPos).then((g) => alive && setGuessedLang(g ?? null));
    return () => {
      alive = false;
    };
  }, [needGuess, canGuess, book, startPos]);

  return { book, status, live, version, savedPos, startPos, lang, needGuess };
}
