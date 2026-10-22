// Where books live on the phone, and the expo-file-system adapters the engine uses.
//
//   <documents>/library.json            the shelf
//   <documents>/settings.json           reader settings
//   <documents>/books/<id>/source.<ext> the original file
//   <documents>/books/<id>/manifest.json
//   <documents>/books/<id>/c/<n>.json   chunks
//   <documents>/books/<id>/img/...      extracted images

import { Directory, File, type FileHandle, FileMode, Paths } from 'expo-file-system';
import type { BookSink, ByteSource, ChunkInfo } from '@/engine/io';

export function booksDir() {
  return new Directory(Paths.document, 'books');
}

export function bookDir(id: string) {
  return new Directory(Paths.document, 'books', id);
}

export function chunkFile(id: string, index: number) {
  return new File(Paths.document, 'books', id, 'c', `${index}.json`);
}

export function imageFile(id: string, name: string) {
  return new File(Paths.document, 'books', id, 'img', name);
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
    return this.handle.readBytes(n);
  }

  close() {
    try {
      this.handle.close();
    } catch {
      // already closed
    }
  }
}

export class FileSink implements BookSink {
  constructor(
    private id: string,
    private onChunk?: (index: number, info: ChunkInfo) => void,
  ) {
    ensureDir(new Directory(bookDir(id), 'c'));
    ensureDir(new Directory(bookDir(id), 'img'));
  }

  writeChunk(index: number, json: string, info: ChunkInfo) {
    chunkFile(this.id, index).write(json);
    this.onChunk?.(index, info);
  }

  writeImage(name: string, data: Uint8Array) {
    imageFile(this.id, name).write(data);
  }

  writeImageBase64(name: string, base64: string) {
    imageFile(this.id, name).write(base64, { encoding: 'base64' });
  }
}

const sibling = (file: File, suffix: string) => new File(file.parentDirectory, file.name + suffix);

function tryRead<T>(file: File): T | null {
  try {
    if (!file.exists) return null;
    return JSON.parse(file.textSync()) as T;
  } catch {
    return null;
  }
}

/**
 * Read a JSON file written by writeJson(). If the app died mid-save or the
 * file got damaged, fall back to the previous good copy.
 */
export function readJson<T>(file: File): T | null {
  return tryRead<T>(file) ?? tryRead<T>(sibling(file, '.bak')) ?? tryRead<T>(sibling(file, '.tmp'));
}

/**
 * Save JSON without ever leaving a half-written file: write a temporary file,
 * keep the previous version as .bak, then move the new one into place.
 */
export function writeJson(file: File, value: unknown) {
  const tmp = sibling(file, '.tmp');
  tmp.write(JSON.stringify(value));
  if (file.exists) {
    try {
      file.copySync(sibling(file, '.bak'), { overwrite: true });
    } catch {
      // a missing backup is not fatal
    }
  }
  tmp.moveSync(file, { overwrite: true });
}
