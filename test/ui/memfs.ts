/// <reference types="jest" />
// An in-memory stand-in for expo-file-system's File/Directory API, enough for
// the real library, storage, conversion and annotation code to run in tests.
// The files live on globalThis, so they survive jest.resetModules(): that is
// how a test "kills the app" and starts it again with only what was on disk.
//
// It behaves like the real module (SDK 58, as read in node_modules/
// expo-file-system/android fsops/CopyMoveStrategy.kt and FileSystemPath.kt,
// ios/FileSystemPath.swift) wherever the app depends on it:
// - move/moveSync change the File's (or Directory's) `uri` to where it went;
//   copy doesn't. Code that keeps using a File after moving it touches the
//   new place.
// - A move or copy onto something that exists fails unless { overwrite: true };
//   with it, the target is deleted first and then the file is renamed: two
//   steps, not one atomic replace.
// - A File destination needs its folder to exist; a Directory destination
//   takes the file under its own name (for another app's file: the name its
//   provider reports, whatever that is).
// - Deleting something that doesn't exist throws, as do reads of it.
// Files handed over by other apps (content:// URIs) are put with putForeign():
// some can't be opened for random access (chat apps), some are pipes whose
// copy() comes out empty (Android sizes the copy from FileChannel.size(),
// which is 0 for a pipe) although reading them start to end works, and some
// can't be read at all.
// Still different from a phone: no permissions model for the app's own
// folders, names aren't percent-decoded, nothing runs in the background (async
// calls finish at once), and the free space is unlimited unless a test sets it.

type Node = { kind: 'file'; data: Uint8Array } | { kind: 'dir' };
/** How a file from another app can be read. */
export interface ForeignOptions {
  /** The name the sending app's provider reports (used when copied into a folder). */
  name?: string;
  /** Only readable from start to end: no file handle (WhatsApp, Telegram). */
  stream?: boolean;
  /** A pipe: no size, and copy() writes an empty file. */
  pipe?: boolean;
  /** Not readable at all any more (the permission ran out). */
  denied?: boolean;
}

const g = globalThis as { __memfs?: Map<string, Node>; __memfsForeign?: Map<string, ForeignOptions>; __memfsLimit?: { bytes?: number } };
export const disk: Map<string, Node> = (g.__memfs ??= new Map());
const foreign: Map<string, ForeignOptions> = (g.__memfsForeign ??= new Map());
const limit: { bytes?: number } = (g.__memfsLimit ??= {});

const ROOT = 'mem://';
const norm = (p: string) => p.replace(/\/+$/, '');
function join(parts: (string | { uri: string })[]) {
  const s = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
  // "file:///a//b/" -> "file:///a/b": doubled slashes go, the scheme's stay.
  const head = /^[a-z][a-z0-9+.-]*:\/\/\/?/i.exec(s)?.[0] ?? '';
  return norm(head + s.slice(head.length).replace(/\/{2,}/g, '/'));
}
/** "scheme://authority": the top of a volume, which always exists. */
const isRoot = (uri: string) => /^[a-z][a-z0-9+.-]*:\/\/[^/]*$/i.test(uri);
const parentOf = (uri: string) => (isRoot(uri) ? uri : uri.slice(0, uri.lastIndexOf('/')));
const nameOf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

const isDir = (uri: string) => isRoot(uri) || disk.get(uri)?.kind === 'dir';
const isFile = (uri: string) => disk.get(uri)?.kind === 'file' && !foreign.get(uri)?.denied;

function readable(uri: string): Uint8Array {
  const f = foreign.get(uri);
  if (f?.denied) throw new Error(`Missing 'READ' permission for accessing the file: ${uri}`);
  const n = disk.get(uri);
  if (!n || n.kind !== 'file') throw new Error(`ENOENT: ${uri}`);
  return n.data;
}

/** Bytes in the app's own folders, for the free-space limit. */
function used(): number {
  let n = 0;
  for (const [k, v] of disk) if (k.startsWith(ROOT) && v.kind === 'file') n += v.data.length;
  return n;
}

function store(uri: string, data: Uint8Array) {
  if (!isDir(parentOf(uri))) throw new Error(`ENOENT: ${parentOf(uri)} (no such directory)`);
  if (isDir(uri)) throw new Error(`EISDIR: ${uri}`);
  if (limit.bytes !== undefined && uri.startsWith(ROOT)) {
    const old = disk.get(uri);
    const now = used() - (old?.kind === 'file' ? old.data.length : 0);
    if (now + data.length > limit.bytes) throw new Error('java.io.IOException: write failed: ENOSPC (No space left on device)');
  }
  disk.set(uri, { kind: 'file', data });
}

function removeTree(uri: string) {
  for (const k of [...disk.keys()]) if (k === uri || k.startsWith(uri + '/')) disk.delete(k);
}

/** Where a file or folder moved or copied to `dest` ends up, made ready as the real module does. */
function target(src: { uri: string; isDir: boolean }, dest: { uri: string }, overwrite?: boolean): string {
  let to: string;
  // By shape, not instanceof: after jest.resetModules() the app's classes are another copy of these.
  if (typeof (dest as Directory).list === 'function') {
    // Into an existing folder: under the source's own name (a provider's file: the name it reports).
    if (isDir(dest.uri)) to = `${dest.uri}/${foreign.get(src.uri)?.name ?? nameOf(src.uri)}`;
    else if (!src.isDir) throw new Error(`DestinationDoesNotExist: ${dest.uri}`);
    else to = dest.uri;
  } else {
    if (src.isDir) throw new Error('CopyOrMoveDirectoryToFile');
    to = dest.uri;
  }
  // "a/b/../c" resolves as the file system would: a hostile reported name can climb out.
  to = to.split('/').reduce<string[]>((out, part) => (part === '..' ? out.slice(0, -1) : [...out, part]), []).join('/');
  if (!isDir(parentOf(to))) throw new Error(`DestinationDoesNotExist: ${parentOf(to)}`);
  if (disk.has(to)) {
    if (!overwrite) throw new Error(`DestinationAlreadyExists: ${to}`);
    removeTree(to); // natively a separate step before the rename
  }
  return to;
}

function snapshot(uri: string): [string, Node][] {
  return [...disk].filter(([k]) => k === uri || k.startsWith(uri + '/'));
}

export class Directory {
  uri: string;
  constructor(...parts: (string | { uri: string })[]) {
    this.uri = join(parts);
  }
  get name() {
    return nameOf(this.uri);
  }
  get exists() {
    return isDir(this.uri);
  }
  get parentDirectory() {
    return new Directory(parentOf(this.uri));
  }
  get size() {
    if (!this.exists) return null;
    let n = 0;
    for (const [k, v] of snapshot(this.uri)) if (k !== this.uri && v.kind === 'file') n += v.data.length;
    return n;
  }
  create(opts?: { intermediates?: boolean; idempotent?: boolean; overwrite?: boolean }) {
    if (this.exists) {
      if (opts?.idempotent) return;
      if (!opts?.overwrite) throw new Error(`EEXIST: ${this.uri}`);
      removeTree(this.uri);
    }
    if (disk.get(this.uri)?.kind === 'file') throw new Error(`EEXIST (a file): ${this.uri}`);
    const parent = parentOf(this.uri);
    if (!isDir(parent)) {
      if (!opts?.intermediates) throw new Error(`ENOENT: ${parent}`);
      new Directory(parent).create({ intermediates: true, idempotent: true });
    }
    disk.set(this.uri, { kind: 'dir' });
  }
  delete() {
    if (disk.get(this.uri)?.kind !== 'dir') throw new Error(`UnableToDelete: ${this.uri} does not exist`);
    removeTree(this.uri);
  }
  list(): (File | Directory)[] {
    if (!this.exists) throw new Error(`ENOENT: ${this.uri}`);
    const out: (File | Directory)[] = [];
    for (const [k, n] of disk) if (k !== this.uri && parentOf(k) === this.uri) out.push(n.kind === 'dir' ? new Directory(k) : new File(k));
    return out;
  }
  copySync(dest: Directory | File, opts?: { overwrite?: boolean }) {
    if (!this.exists) throw new Error(`ENOENT: ${this.uri}`);
    const items = snapshot(this.uri);
    const to = target({ uri: this.uri, isDir: true }, dest, opts?.overwrite);
    for (const [k, n] of items) disk.set(to + k.slice(this.uri.length), n.kind === 'file' ? { kind: 'file', data: n.data.slice() } : n);
  }
  copy(dest: Directory | File, opts?: { overwrite?: boolean }) {
    return settle(() => this.copySync(dest, opts));
  }
  moveSync(dest: Directory | File, opts?: { overwrite?: boolean }) {
    if (!this.exists) throw new Error(`ENOENT: ${this.uri}`);
    const items = snapshot(this.uri);
    const to = target({ uri: this.uri, isDir: true }, dest, opts?.overwrite);
    removeTree(this.uri);
    for (const [k, n] of items) disk.set(to + k.slice(this.uri.length), n);
    this.uri = to;
  }
  move(dest: Directory | File, opts?: { overwrite?: boolean }) {
    return settle(() => this.moveSync(dest, opts));
  }
  rename(newName: string) {
    this.moveSync(new Directory(parentOf(this.uri), newName));
  }
}

const settle = (f: () => void) => {
  try {
    f();
    return Promise.resolve();
  } catch (e) {
    return Promise.reject(e);
  }
};

export class File {
  uri: string;
  constructor(...parts: (string | { uri: string })[]) {
    this.uri = join(parts);
  }
  get name() {
    return nameOf(this.uri);
  }
  get extension() {
    const n = this.name;
    const i = n.lastIndexOf('.');
    return i > 0 ? n.slice(i) : '';
  }
  get contentUri() {
    return this.uri;
  }
  get exists() {
    return isFile(this.uri);
  }
  get size() {
    if (!this.exists || foreign.get(this.uri)?.pipe) return 0;
    return (disk.get(this.uri) as { data: Uint8Array }).data.length;
  }
  get parentDirectory() {
    return new Directory(parentOf(this.uri));
  }
  textSync() {
    return fromUtf8.decode(readable(this.uri));
  }
  text() {
    return attempt(() => this.textSync());
  }
  bytesSync() {
    return readable(this.uri).slice();
  }
  bytes() {
    return attempt(() => this.bytesSync());
  }
  base64Sync() {
    return Buffer.from(readable(this.uri)).toString('base64');
  }
  base64() {
    return attempt(() => this.base64Sync());
  }
  digest(algorithm: string) {
    return attempt(() => {
      const { createHash } = require('crypto') as typeof import('crypto');
      return createHash(algorithm.replace('-', '').toLowerCase()).update(readable(this.uri)).digest('hex');
    });
  }
  info() {
    return this.exists ? { exists: true, uri: this.uri, size: this.size } : { exists: false, uri: this.uri };
  }
  create(opts?: { intermediates?: boolean; overwrite?: boolean }) {
    if (this.exists && !opts?.overwrite) throw new Error(`EEXIST: ${this.uri}`);
    if (opts?.intermediates) new Directory(parentOf(this.uri)).create({ intermediates: true, idempotent: true });
    store(this.uri, new Uint8Array(0));
  }
  writeSync(content: string | Uint8Array, opts?: { encoding?: string; append?: boolean }) {
    const data =
      typeof content === 'string' ? (opts?.encoding === 'base64' ? Uint8Array.from(Buffer.from(content, 'base64')) : utf8.encode(content)) : content.slice();
    const old = opts?.append && this.exists ? readable(this.uri) : null;
    store(this.uri, old ? Uint8Array.from([...old, ...data]) : data);
  }
  write(content: string | Uint8Array, opts?: { encoding?: string; append?: boolean }) {
    return settle(() => this.writeSync(content, opts));
  }
  copySync(dest: File | Directory, opts?: { overwrite?: boolean }) {
    copyFile(this.uri, dest, opts?.overwrite);
  }
  copy(dest: File | Directory, opts?: { overwrite?: boolean }) {
    return settle(() => copyFile(this.uri, dest, opts?.overwrite));
  }
  moveSync(dest: File | Directory, opts?: { overwrite?: boolean }) {
    this.uri = moveFile(this.uri, dest, opts?.overwrite);
  }
  move(dest: File | Directory, opts?: { overwrite?: boolean }) {
    return settle(() => {
      this.uri = moveFile(this.uri, dest, opts?.overwrite);
    });
  }
  rename(newName: string) {
    this.moveSync(new File(parentOf(this.uri), newName));
  }
  delete() {
    if (foreign.has(this.uri)) throw new Error('UnsupportedOperation: cannot delete from a content provider');
    if (disk.get(this.uri)?.kind !== 'file') throw new Error(`UnableToDelete: ${this.uri} does not exist`);
    disk.delete(this.uri);
  }
  open() {
    const f = foreign.get(this.uri);
    if (f?.stream || f?.pipe) throw new Error(`Failed to open file handle for content:// URI: ${this.uri}. The content provider may not support random access.`);
    const data = readable(this.uri);
    let open = true;
    let offset = 0;
    return {
      get size() {
        return open ? data.length : null;
      },
      get offset() {
        return open ? offset : null;
      },
      set offset(n: number | null) {
        offset = n ?? 0;
      },
      readBytesSync(n: number) {
        if (!open) throw new Error('The file handle is closed');
        const out = data.slice(offset, offset + n);
        offset += out.length;
        return out;
      },
      readBytes(n: number) {
        return attempt(() => this.readBytesSync(n));
      },
      close() {
        open = false;
      },
    };
  }
}

function copyFile(uri: string, dest: File | Directory, overwrite?: boolean) {
  const data = readable(uri);
  const to = target({ uri, isDir: false }, dest, overwrite);
  // Android copies another app's file through its FileChannel, sized by
  // FileChannel.size(): 0 for a pipe, so nothing is copied.
  store(to, foreign.get(uri)?.pipe ? new Uint8Array(0) : data.slice());
}

/** Move a file; returns where it went. */
function moveFile(uri: string, dest: File | Directory, overwrite?: boolean): string {
  if (foreign.has(uri)) throw new Error('UnableToMove: content provider file cannot be moved');
  const data = readable(uri);
  const to = target({ uri, isDir: false }, dest, overwrite);
  disk.delete(uri);
  disk.set(to, { kind: 'file', data });
  return to;
}

function attempt<T>(f: () => T): Promise<T> {
  try {
    return Promise.resolve(f());
  } catch (e) {
    return Promise.reject(e);
  }
}

export const Paths = {
  get document() {
    return new Directory(ROOT + 'doc');
  },
  get cache() {
    return new Directory(ROOT + 'cache');
  },
  get totalDiskSpace() {
    return limit.bytes ?? 64e9;
  },
  get availableDiskSpace() {
    return limit.bytes === undefined ? 32e9 : Math.max(0, limit.bytes - used());
  },
};

export const FileMode = { ReadOnly: 'r', ReadWrite: 'rw', WriteOnly: 'w', Append: 'wa', Truncate: 'wt' };

/** Put a file on the "phone" (e.g. one the document picker hands over). */
export function putFile(uri: string, data: Uint8Array) {
  const at = join([uri]);
  new Directory(parentOf(at)).create({ intermediates: true, idempotent: true });
  disk.set(at, { kind: 'file', data });
}

/** A file another app hands over (a content:// URI), and how it can be read. */
export function putForeign(uri: string, data: Uint8Array, opts: ForeignOptions = {}) {
  const at = join([uri]);
  disk.set(at, { kind: 'file', data });
  foreign.set(at, opts);
}

/** Free space for the app's files from now on, in bytes (undefined: plenty). Writes beyond it fail as a full phone's do. */
export function setFreeSpace(bytes?: number) {
  limit.bytes = bytes === undefined ? undefined : used() + bytes;
}

export function resetDisk() {
  disk.clear();
  foreign.clear();
  limit.bytes = undefined;
  disk.set(ROOT + 'doc', { kind: 'dir' });
  disk.set(ROOT + 'cache', { kind: 'dir' });
}
