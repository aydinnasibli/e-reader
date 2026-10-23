/// <reference types="jest" />
// An in-memory stand-in for expo-file-system's File/Directory API, enough for
// the real library, storage, conversion and annotation code to run in tests.
// The files live on globalThis, so they survive jest.resetModules(): that is
// how a test "kills the app" and starts it again with only what was on disk.

type Node = { kind: 'file'; data: Uint8Array } | { kind: 'dir' };

const g = globalThis as { __memfs?: Map<string, Node> };
export const disk: Map<string, Node> = (g.__memfs ??= new Map());

const ROOT = 'mem://';
const norm = (p: string) => p.replace(/\/+$/, '');
const join = (parts: (string | { uri: string })[]) =>
  norm(parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/').replace(/([^:])\/{2,}/g, '$1/'));
const parentOf = (uri: string) => uri.slice(0, uri.lastIndexOf('/'));
const nameOf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

function need(uri: string, kind: Node['kind']) {
  const n = disk.get(uri);
  if (!n || n.kind !== kind) throw new Error(`ENOENT: ${uri}`);
  return n;
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
    return disk.get(this.uri)?.kind === 'dir';
  }
  get parentDirectory() {
    return new Directory(parentOf(this.uri));
  }
  create(opts?: { intermediates?: boolean; idempotent?: boolean }) {
    if (this.exists) {
      if (opts?.idempotent) return;
      throw new Error(`EEXIST: ${this.uri}`);
    }
    if (!disk.has(parentOf(this.uri)) && parentOf(this.uri) !== 'mem:/') {
      if (!opts?.intermediates) throw new Error(`ENOENT: ${parentOf(this.uri)}`);
      new Directory(parentOf(this.uri)).create({ intermediates: true, idempotent: true });
    }
    disk.set(this.uri, { kind: 'dir' });
  }
  delete() {
    need(this.uri, 'dir');
    for (const k of [...disk.keys()]) if (k === this.uri || k.startsWith(this.uri + '/')) disk.delete(k);
  }
  list(): (File | Directory)[] {
    need(this.uri, 'dir');
    const out: (File | Directory)[] = [];
    for (const [k, n] of disk) if (parentOf(k) === this.uri) out.push(n.kind === 'dir' ? new Directory(k) : new File(k));
    return out;
  }
}

export class File {
  uri: string;
  constructor(...parts: (string | { uri: string })[]) {
    this.uri = join(parts);
  }
  get name() {
    return nameOf(this.uri);
  }
  get contentUri() {
    return this.uri;
  }
  get exists() {
    return disk.get(this.uri)?.kind === 'file';
  }
  get size() {
    const n = disk.get(this.uri);
    return n?.kind === 'file' ? n.data.length : 0;
  }
  get parentDirectory() {
    return new Directory(parentOf(this.uri));
  }
  private bytes() {
    return (need(this.uri, 'file') as { data: Uint8Array }).data;
  }
  textSync() {
    return fromUtf8.decode(this.bytes());
  }
  text() {
    try {
      return Promise.resolve(this.textSync());
    } catch (e) {
      return Promise.reject(e);
    }
  }
  writeSync(content: string | Uint8Array, opts?: { encoding?: string }) {
    if (disk.get(parentOf(this.uri))?.kind !== 'dir') throw new Error(`ENOENT: ${parentOf(this.uri)}`);
    const data =
      typeof content === 'string' ? (opts?.encoding === 'base64' ? Uint8Array.from(Buffer.from(content, 'base64')) : utf8.encode(content)) : content.slice();
    disk.set(this.uri, { kind: 'file', data });
  }
  copySync(dest: File, opts?: { overwrite?: boolean }) {
    if (dest.exists && !opts?.overwrite) throw new Error(`EEXIST: ${dest.uri}`);
    dest.writeSync(this.bytes());
  }
  copy(dest: File) {
    try {
      this.copySync(dest);
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }
  moveSync(dest: File, opts?: { overwrite?: boolean }) {
    this.copySync(dest, opts);
    disk.delete(this.uri);
    this.uri = dest.uri;
  }
  delete() {
    need(this.uri, 'file');
    disk.delete(this.uri);
  }
  open() {
    const data = this.bytes();
    return {
      size: data.length,
      offset: 0,
      readBytesSync(n: number) {
        const out = data.slice(this.offset, this.offset + n);
        this.offset += out.length;
        return out;
      },
      close() {},
    };
  }
}

export const Paths = {
  get document() {
    return new Directory(ROOT + 'doc');
  },
  get cache() {
    return new Directory(ROOT + 'cache');
  },
};

export const FileMode = { ReadOnly: 'r' };

/** Put a file on the "phone" (e.g. one the document picker hands over). */
export function putFile(uri: string, data: Uint8Array) {
  new Directory(parentOf(uri)).create({ intermediates: true, idempotent: true });
  disk.set(uri, { kind: 'file', data });
}

export function resetDisk() {
  disk.clear();
  disk.set(ROOT + 'doc', { kind: 'dir' });
  disk.set(ROOT + 'cache', { kind: 'dir' });
}
