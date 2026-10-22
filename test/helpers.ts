/// <reference types="node" />
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { BookSink, ByteSource, IngestContext } from '../src/engine/io';
import type { Block, ChunkFile, Manifest } from '../src/engine/types';
import { ingestBook } from '../src/engine/ingest';

export class MemorySource implements ByteSource {
  constructor(private bytes: Uint8Array) {}
  get size() {
    return this.bytes.length;
  }
  read(offset: number, length: number) {
    return this.bytes.slice(offset, offset + length);
  }
}

export class FileSource implements ByteSource {
  private fd: number;
  readonly size: number;
  constructor(path: string) {
    this.fd = openSync(path, 'r');
    this.size = fstatSync(this.fd).size;
  }
  read(offset: number, length: number) {
    const n = Math.max(0, Math.min(length, this.size - offset));
    const buf = new Uint8Array(n);
    readSync(this.fd, buf, 0, n, offset);
    return buf;
  }
  close() {
    closeSync(this.fd);
  }
}

export class MemorySink implements BookSink {
  chunks: string[] = [];
  images = new Map<string, Uint8Array | string>();
  bytesWritten = 0;
  constructor(private keep = true) {}
  writeChunk(index: number, json: string) {
    this.bytesWritten += json.length;
    if (this.keep) this.chunks[index] = json;
  }
  writeImage(name: string, data: Uint8Array) {
    this.images.set(name, data);
  }
  writeImageBase64(name: string, b64: string) {
    this.images.set(name, b64);
  }
  blocks(): Block[] {
    return this.chunks.flatMap((c) => (JSON.parse(c) as ChunkFile).b);
  }
}

export async function ingestBytes(bytes: Uint8Array, name: string) {
  const sink = new MemorySink();
  const ctx: IngestContext = {
    src: new MemorySource(bytes),
    sink,
    progress() {},
    pause: async () => {},
    fallbackTitle: name,
  };
  const manifest: Manifest = await ingestBook(ctx, name);
  return { manifest, sink, blocks: sink.blocks() };
}

export const enc = (s: string) => new TextEncoder().encode(s);
