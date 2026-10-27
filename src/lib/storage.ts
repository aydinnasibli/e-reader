// Where books live on the phone, and the expo-file-system adapters the engine uses.
//
//   <documents>/library.json            the shelf
//   <documents>/settings.json           reader settings
//   <documents>/books/<id>/source.<ext> the original file
//   <documents>/books/<id>/manifest.json
//   <documents>/books/<id>/c/<n>.json   chunks
//   <documents>/books/<id>/img/...      extracted images
//   <documents>/books/<id>/next/...     a conversion by a newer converter, until it takes over (library.ts)

import { Directory, File, type FileHandle, FileMode, Paths } from 'expo-file-system';
import { strToU8 } from 'fflate';
import type { BookSink, ByteSource, ChunkInfo } from '@/engine/io';
import { hashBytes } from './fingerprint';

export function booksDir() {
  return new Directory(Paths.document, 'books');
}

export function bookDir(id: string) {
  return new Directory(Paths.document, 'books', id);
}

/** Where a book is converted again (manifest.json, c/, img/) while it is read as it was. */
export function nextDir(id: string) {
  return new Directory(Paths.document, 'books', id, 'next');
}

export function chunkFile(id: string, index: number) {
  return new File(Paths.document, 'books', id, 'c', `${index}.json`);
}

export function imageFile(id: string, name: string) {
  return new File(Paths.document, 'books', id, 'img', name);
}

const UNSAFE = /[^A-Za-z0-9._-]/g;
const MAX_NAME = 100;

/**
 * A file name for an image from its name inside the book: safe characters
 * only, never a path. A name that had to change gets a hash of the original,
 * so "a/b.png" and "a_b.png" in one EPUB don't share a file.
 */
export function safeImageName(key: string): string {
  const safe = key.replace(UNSAFE, '_');
  return safe === key && safe.length <= MAX_NAME ? safe : `${safe.slice(0, MAX_NAME)}-${hashBytes(strToU8(key))}`;
}

export function manifestFile(id: string) {
  return new File(Paths.document, 'books', id, 'manifest.json');
}

export function ensureDir(d: Directory) {
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
}

/** Random-access reads through a native file handle; nothing is loaded up front. */
export class FileSource implements ByteSource {
  private handle: FileHandle;
  readonly size: number;

  constructor(file: File) {
    this.handle = file.open(FileMode.ReadOnly);
    this.size = this.handle.size ?? file.size;
  }

  read(offset: number, length: number): Uint8Array {
    const n = Math.max(0, Math.min(length, this.size - offset));
    if (n === 0) return new Uint8Array(0);
    this.handle.offset = offset;
    return this.handle.readBytesSync(n);
  }

  close() {
    try {
      this.handle.close();
    } catch {
      // already closed
    }
  }
}

/** Writes a conversion into `root` (the book's folder, or nextDir() when converting it again). */
export class FileSink implements BookSink {
  private chunks: Directory;
  private images: Directory;

  constructor(
    id: string,
    private onChunk?: (index: number, info: ChunkInfo) => void,
    root: Directory = bookDir(id),
  ) {
    this.chunks = new Directory(root, 'c');
    this.images = new Directory(root, 'img');
    ensureDir(this.chunks);
    ensureDir(this.images);
  }

  writeChunk(index: number, json: string, info: ChunkInfo) {
    new File(this.chunks, `${index}.json`).writeSync(json);
    this.onChunk?.(index, info);
  }

  writeImage(name: string, data: Uint8Array) {
    new File(this.images, name).writeSync(data);
  }

  writeImageBase64(name: string, base64: string) {
    new File(this.images, name).writeSync(base64, { encoding: 'base64' });
  }
}

const sibling = (file: File, suffix: string) => new File(file.parentDirectory, file.name + suffix);

/**
 * The copies writeJson() keeps beside a file: the previous version (.bak),
 * a new one not yet in place (.tmp), and a damaged one kept aside (.unreadable).
 */
export function savedCopies(file: File): File[] {
  return ['.bak', '.tmp', '.unreadable'].map((s) => sibling(file, s));
}

function tryRead<T>(file: File, valid?: (v: unknown) => boolean): T | null {
  try {
    if (!file.exists) return null;
    const v: unknown = JSON.parse(file.textSync());
    return v !== null && (!valid || valid(v)) ? (v as T) : null;
  } catch {
    return null;
  }
}

/** Files found unreadable by readJson(), kept aside rather than made the backup when next saved. */
const unreadable = new Set<string>();

/**
 * Read a JSON file written by writeJson(). If the app died mid-save or the
 * file got damaged, fall back to the newest good copy: the new version
 * waiting in .tmp (moving it into place deletes the old file first, then
 * renames, so a save cut off between the two leaves only that), then the
 * previous version in .bak. `valid`: what the file must hold (an array, an
 * object with these fields); JSON of another shape counts as damaged.
 */
export function readJson<T>(file: File, valid?: (v: unknown) => boolean): T | null {
  const main = tryRead<T>(file, valid);
  if (main !== null) return main;
  try {
    if (file.exists) unreadable.add(file.uri);
  } catch {
    // can't tell; nothing to keep aside
  }
  return tryRead<T>(sibling(file, '.tmp'), valid) ?? tryRead<T>(sibling(file, '.bak'), valid);
}

/**
 * Save JSON without ever leaving a half-written file: write a temporary file,
 * keep the previous version as .bak, then move the new one into place. A
 * file that couldn't be read is kept as .unreadable instead (it may hold
 * more than the copy read in its place), and the good .bak stays.
 */
export function writeJson(file: File, value: unknown) {
  const tmp = sibling(file, '.tmp');
  tmp.writeSync(JSON.stringify(value));
  if (file.exists) {
    try {
      if (unreadable.delete(file.uri)) file.copySync(sibling(file, '.unreadable'), { overwrite: true });
      else file.copySync(sibling(file, '.bak'), { overwrite: true });
    } catch {
      // a missing backup is not fatal
    }
  }
  tmp.moveSync(file, { overwrite: true });
}

/**
 * Delete a JSON file written by writeJson() with its saved copies: deleting
 * only the file would let readJson() bring back its previous version. The
 * copies go first, so a delete cut short leaves the file as it was.
 */
export function removeJson(file: File) {
  unreadable.delete(file.uri);
  for (const f of [...savedCopies(file), file]) {
    try {
      if (f.exists) f.delete();
    } catch {
      // gone with the book's folder anyway
    }
  }
}

/**
 * writeJson for app state saved from timers and taps: a failed save (storage
 * full, file locked) must not crash the app. Returns whether it was saved.
 */
export function saveJson(file: File, value: unknown): boolean {
  try {
    writeJson(file, value);
    return true;
  } catch (e) {
    console.warn(`Could not save ${file.name}:`, e);
    return false;
  }
}
