// Books coming in: picked with the document picker, or handed over by another
// app ("Open with"). Each file is copied into the app, recognised from its
// bytes when its name can't be trusted, checked against the shelf (the same
// file twice is the same book), and put on the shelf to be converted.

import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { bookExtension, bookFileName, isSupportedName, type SniffedFormat, sniffFormat, titleFromFileName } from '@/engine/ingest';
import { recordCrash } from './crashLog';
import { fingerprintOf } from './fingerprint';
import { newId } from './ids';
import { type BookEntry, bookList, emit, flushLibrary, getBook, scheduleSave, sourceExists, sourceFile, updateBook } from './libraryStore';
import { SPARE_BYTES, queueMarks, runQueue } from './libraryQueue';
import { claimPending } from './restore';
import { freeSpace, isNoSpace } from './space';
import { FileSource, bookDir, ensureDir } from './storage';

export interface ImportResult {
  added: number;
  /** Not a supported format. */
  skipped: string[];
  /** Couldn't be stored: not enough free space. */
  failed: string[];
  /** Couldn't be read: the app or service holding it didn't allow it, or it's gone. */
  unreadable: string[];
  /** Couldn't be added for another reason (kept in the crash log). */
  other: string[];
  /** Already on the shelf: [file name, title of the book on the shelf]. */
  duplicates: [string, string][];
}

/** Fingerprint of a file, or undefined when it can't be read. */
function fingerprintFile(file: File): string | undefined {
  let src: FileSource | undefined;
  try {
    src = new FileSource(file);
    return fingerprintOf(src);
  } catch {
    return undefined;
  } finally {
    src?.close();
  }
}

/** The book file's fingerprint; worked out (and kept) for books added by older versions. */
export function fingerprintBook(b: BookEntry): string | undefined {
  if (b.fp) return b.fp;
  const fp = fingerprintFile(sourceFile(b));
  if (fp) updateBook(b.id, { fp });
  return fp;
}

/**
 * The book on the shelf that is this file, if any. Books added by older
 * versions get their fingerprint here, the first time a file of the same
 * size comes in. A book that failed to prepare counts too: adding it again
 * would only add another failed copy, and the one on the shelf offers to
 * try again.
 */
function findDuplicate(fp: string, size: number): BookEntry | undefined {
  for (const b of bookList()) {
    if (!b.fp && b.size === size) {
      const f = fingerprintFile(sourceFile(b));
      if (f) b.fp = f;
    }
    if (b.fp === fp) return b;
  }
  return undefined;
}

type AddOutcome = { added: BookEntry } | { duplicate: BookEntry } | { failed: true };

/**
 * Put one file on the shelf by moving it into the book's folder; a file
 * that is already on the shelf is dropped instead, unless that book lost its
 * own file: then this one repairs it. `file` must be the app's own copy
 * (addIncoming's), so moving it is instant even for huge files. The caller
 * saves and starts conversion with finishAdding().
 */
function addFile(file: File, name: string, size: number): AddOutcome {
  const fp = fingerprintFile(file);
  const dup = fp ? findDuplicate(fp, size) : undefined;
  if (dup) {
    if (!sourceExists(dup) && repairSource(dup, file)) return { added: getBook(dup.id)! };
    try {
      file.delete();
    } catch {
      // the cache is cleared by the system anyway
    }
    return { duplicate: dup };
  }
  const id = newId();
  const dir = bookDir(id);
  try {
    ensureDir(dir);
    const dest = new File(dir, `source.${bookExtension(name) ?? 'bin'}`);
    // A moved File points at where it went (its uri changes), so a fresh one
    // is moved and the caller's still names the incoming copy.
    new File(file.uri).moveSync(dest);
    const now = Date.now();
    const book: BookEntry = {
      id,
      title: titleFromFileName(name),
      author: '',
      fileName: name,
      sourceName: dest.name,
      size: dest.size,
      addedAt: now,
      openedAt: now,
      status: 'processing',
      progress: 0,
      ...(fp ? { fp } : {}),
    };
    // A restored backup may hold this book's highlights, place and collections.
    try {
      Object.assign(book, claimPending(id, book, queueMarks));
    } catch {
      // adding the book matters more; the saved data stays waiting
    }
    bookList().unshift(book);
    return { added: book };
  } catch (e) {
    // Usually storage full; kept in the crash log in case it's something else.
    recordCrash('error', e);
    // Don't leave a half-copied book behind.
    try {
      if (dir.exists) dir.delete();
    } catch {
      // recoverOrphans() tidies it next launch
    }
    return { failed: true };
  }
}

/**
 * A book whose original file was lost gets this copy of it: its pictures
 * show again, and it is converted again (with its marks) if it needs to be.
 */
function repairSource(book: BookEntry, file: File): boolean {
  try {
    ensureDir(bookDir(book.id));
    new File(file.uri).moveSync(sourceFile(book));
  } catch {
    return false;
  }
  const failed = book.status === 'error';
  updateBook(book.id, {
    sourceMissing: undefined,
    upgradeFailed: undefined,
    ...(failed ? { status: 'processing', progress: 0, error: undefined, attempts: 0 } : {}),
  });
  return true;
}

/** Save what addFile() did and start converting the new books. */
function finishAdding(added: number) {
  if (added) {
    emit();
    flushLibrary();
    void runQueue();
  } else scheduleSave(); // fingerprints filled in by findDuplicate()
}

const NO_ROOM = { noSpace: true } as const;

type Incoming = AddOutcome | { unsupported: true } | { unreadable: true } | typeof NO_ROOM;

/**
 * Copy a file from elsewhere (picked, or handed over by another app) into the
 * app with the asynchronous file API, recognise it and put it on the shelf.
 * `name`: the picker's name for it; a shared file's name comes from its URI,
 * and it is always recognised from its bytes (the name could be anything).
 */
async function addIncoming(src: File, opts: { name: string; size?: number; shared: boolean }): Promise<Incoming> {
  const trustName = !opts.shared && isSupportedName(opts.name);
  let format: SniffedFormat | null | undefined;
  // A plain file is recognised where it is, so that a huge video isn't
  // copied just to be refused. Anything from another app is copied first:
  // reading it in place can mean waiting for a download (a cloud file) with
  // the app frozen, and some apps hand over a stream whose size isn't known.
  if (!trustName && /^file:/i.test(src.uri)) {
    format = sniffFile(src);
    if (format === null) return { unsupported: true };
  }
  const size = opts.size || 0;
  if (size && freeSpace() < size + SPARE_BYTES) return NO_ROOM;
  // Copied under a name of our own. Copied into a folder, the file would get
  // the name the sending app reports, which could be "../../files/library.json".
  const incoming = new Directory(Paths.cache, 'incoming');
  const copy = new File(incoming, newId());
  const at = copy.uri;
  try {
    try {
      ensureDir(incoming);
      await src.copy(copy);
      // Some apps hand over a pipe, which Android copies as an empty file
      // (it sizes the copy by the channel, 0 for a pipe): read it through instead.
      if (!copy.size) {
        const bytes = await src.bytes();
        if (bytes.length) await copy.write(bytes);
      }
    } catch (e) {
      if (isNoSpace(e) || (size > 0 && freeSpace() < size)) return NO_ROOM;
      // Why it couldn't be read (a permission, a provider that went away) is kept for the crash log.
      recordCrash('error', e);
      return { unreadable: true };
    }
    if (!copy.size) return { unsupported: true }; // an empty file
    // Chat apps usually only let the file be read from start to end: recognised once copied.
    if (format === undefined && !trustName) format = sniffFile(copy);
    if (format === null) return { unsupported: true };
    if (format === undefined && !trustName) return { unreadable: true };
    const name = trustName || !format ? opts.name : bookFileName(opts.shared ? sharedFileName(src) : opts.name, format);
    const r = addFile(copy, name, copy.size);
    return 'failed' in r && freeSpace() < copy.size + SPARE_BYTES ? NO_ROOM : r;
  } finally {
    try {
      const left = new File(at);
      if (left.exists) left.delete();
    } catch {
      // the cache is cleared by the system anyway
    }
  }
}

/** Let the user pick files and add them to the shelf. */
export async function importBooks(): Promise<ImportResult> {
  // The picker isn't asked for its own copy: Android makes it on the UI
  // thread (the app freezes for a big book), and in Expo Go the copy lands
  // where the app may not read it. Each file is copied in by addIncoming().
  const res = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: false });
  const result: ImportResult = { added: 0, skipped: [], failed: [], unreadable: [], other: [], duplicates: [] };
  if (res.canceled) return result;
  try {
    for (const asset of res.assets) {
      const r = await addIncoming(new File(asset.uri), { name: asset.name, size: asset.size ?? undefined, shared: false });
      if ('added' in r) {
        result.added++;
        finishAdding(1);
      } else if ('duplicate' in r) result.duplicates.push([asset.name, r.duplicate.title]);
      else if ('unsupported' in r) result.skipped.push(asset.name);
      else if ('unreadable' in r) result.unreadable.push(asset.name);
      else if ('noSpace' in r) result.failed.push(asset.name);
      else result.other.push(asset.name);
      dropPickedCopy(asset.uri);
    }
  } finally {
    if (!result.added) finishAdding(0);
  }
  return result;
}

/** iOS hands the picked file over as the app's own temporary copy: not kept once added. */
function dropPickedCopy(uri: string) {
  if (Platform.OS !== 'ios' || !/^file:.*\/tmp\//i.test(uri)) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // iOS clears the app's temporary files itself
  }
}

export type SharedFileResult =
  | { book: BookEntry; duplicate: boolean }
  /** Not a book this app reads. */
  | { unsupported: true }
  /** Couldn't be read (no permission, gone), there's no room for it, or something else went wrong (in the crash log). */
  | { failed: 'unreadable' | 'space' | 'other' };

/** importSharedFile() once the library is loaded (library.ts). */
export async function addSharedFile(uri: string): Promise<SharedFileResult> {
  const r = await addIncoming(new File(uri), { name: '', shared: true });
  finishAdding('added' in r ? 1 : 0);
  if ('added' in r) return { book: r.added, duplicate: false };
  if ('duplicate' in r) return { book: r.duplicate, duplicate: true };
  if ('unsupported' in r) return { unsupported: true };
  return { failed: 'unreadable' in r ? 'unreadable' : 'noSpace' in r ? 'space' : 'other' };
}

/** What book a file is from its bytes: null if none, undefined if it can't be read where it is. */
function sniffFile(file: File): SniffedFormat | null | undefined {
  let src: FileSource | undefined;
  try {
    src = new FileSource(file);
    // A size of 0 can also mean "unknown" (a pipe): not readable here.
    return src.size > 0 ? sniffFormat(src) : undefined;
  } catch {
    return undefined;
  } finally {
    src?.close();
  }
}

/**
 * A name for a shared file to show as its title, from the end of its URI
 * ("My%20Book.epub"): no folders, control characters or leading dots, and
 * not endless. Many apps share a file under an id ("…/item/48213",
 * "msf:1000001234") rather than its name: then none (the book's own title,
 * or a text's first line, is used instead).
 */
function sharedFileName(file: File): string {
  let name = file.name;
  try {
    name = decodeURIComponent(name);
  } catch {
    // not percent-encoded after all
  }
  const clean = (name.split(/[/\\]/).pop() ?? '').replace(/\p{Cc}/gu, '').replace(/^[.\s]+/, '').slice(0, 120);
  return bookExtension(clean) ? clean : '';
}
