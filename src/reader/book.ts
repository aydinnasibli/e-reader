// Reader-side access to a converted book: loads chunks on demand (keeping a
// small cache), maps positions to percentages, and extracts images lazily.

import { Image } from 'react-native';
import type { Block, ChunkFile, Manifest, Position, TocEntry } from '@/engine/types';
import { blockLength } from '@/engine/types';
import { ZipArchive, readZipData } from '@/engine/zip';
import { type BookEntry, type LiveBook, sourceFile } from '@/lib/library';
import { FileSource, chunkFile, imageFile } from '@/lib/storage';

const CACHE_CHUNKS = 12;

export interface ImageInfo {
  uri: string;
  width: number;
  height: number;
}

export class BookData {
  chunks: [number, number][] = [];
  totalBlocks = 0;
  totalChars = 0;
  /** True once conversion has finished. */
  complete = false;
  /** Conversion progress while processing (0..1). */
  progress = 1;
  toc: TocEntry[] = [];
  manifest: Manifest | null = null;

  private cache = new Map<number, Block[]>();
  private loading = new Map<number, Promise<Block[]>>();
  private src: FileSource | null = null;
  private zip: ZipArchive | null | undefined;
  private images = new Map<string, Promise<ImageInfo | null>>();
  private imageSizes = new Map<string, ImageInfo | null>();

  constructor(readonly entry: BookEntry) {}

  setManifest(m: Manifest) {
    this.manifest = m;
    this.chunks = m.chunks;
    this.totalBlocks = m.totalBlocks;
    this.totalChars = m.totalChars;
    this.toc = m.toc;
    this.complete = true;
    this.progress = 1;
  }

  setLive(live: LiveBook) {
    if (this.complete) return;
    this.chunks = live.chunks;
    this.totalBlocks = live.totalBlocks;
    this.totalChars = live.totalChars;
    this.progress = live.progress;
  }

  get chunkCount() {
    return this.chunks.length;
  }

  /** Total characters, estimated from progress while the book is still converting. */
  get estimatedChars() {
    if (this.complete) return this.totalChars;
    return this.progress > 0.01 ? this.totalChars / this.progress : this.totalChars * 10;
  }

  chunkStart(i: number) {
    return this.chunks[i]?.[0] ?? this.totalBlocks;
  }

  chunkEnd(i: number) {
    return i + 1 < this.chunks.length ? this.chunks[i + 1][0] : this.totalBlocks;
  }

  /** Characters in chunk `i`. */
  chunkChars(i: number): number {
    const start = this.chunks[i]?.[1] ?? 0;
    const end = i + 1 < this.chunks.length ? this.chunks[i + 1][1] : this.totalChars;
    return Math.max(0, end - start);
  }

  chunkOf(block: number): number {
    let lo = 0;
    let hi = this.chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.chunks[mid][0] <= block) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  cached(i: number): Block[] | undefined {
    return this.cache.get(i);
  }

  block(b: number): Block | undefined {
    const i = this.chunkOf(b);
    return this.cache.get(i)?.[b - this.chunkStart(i)];
  }

  /** Called when book data can't be read (damaged files). */
  onError?: (e: unknown) => void;

  /**
   * Load a chunk. On failure the error goes to onError and the returned
   * promise never settles, so callers don't each need failure handling.
   */
  loadChunk(i: number): Promise<Block[]> {
    return this.readChunk(i).catch((e) => {
      this.onError?.(e);
      return new Promise<Block[]>(() => {});
    });
  }

  private readChunk(i: number): Promise<Block[]> {
    const hit = this.cache.get(i);
    if (hit) {
      // refresh LRU order
      this.cache.delete(i);
      this.cache.set(i, hit);
      return Promise.resolve(hit);
    }
    let p = this.loading.get(i);
    if (!p) {
      p = chunkFile(this.entry.id, i)
        .text()
        .then((t) => {
          const blocks = (JSON.parse(t) as ChunkFile).b;
          this.cache.set(i, blocks);
          this.loading.delete(i);
          while (this.cache.size > CACHE_CHUNKS) this.cache.delete(this.cache.keys().next().value!);
          return blocks;
        });
      p.catch(() => this.loading.delete(i));
      this.loading.set(i, p);
    }
    return p;
  }

  /** Characters before a position. Needs the position's chunk loaded. */
  charOffset(pos: Position): number {
    const i = this.chunkOf(pos.b);
    const blocks = this.cache.get(i);
    let n = this.chunks[i]?.[1] ?? 0;
    if (!blocks) return n;
    const start = this.chunkStart(i);
    for (let b = start; b < pos.b && b - start < blocks.length; b++) n += blockLength(blocks[b - start]);
    const cur = blocks[pos.b - start];
    if (cur) n += Math.min(pos.o, blockLength(cur));
    return n;
  }

  fraction(pos: Position): number {
    const total = this.estimatedChars;
    return total > 0 ? Math.min(1, this.charOffset(pos) / total) : 0;
  }

  /** Position at a fraction of the book (progress slider, go to page), down to the character. */
  async positionAt(fraction: number): Promise<Position> {
    if (!this.chunks.length) return { b: 0, o: 0 };
    const target = Math.max(0, Math.min(this.totalChars - 1, fraction * this.estimatedChars));
    let lo = 0;
    let hi = this.chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.chunks[mid][1] <= target) lo = mid;
      else hi = mid - 1;
    }
    const blocks = await this.loadChunk(lo);
    let n = this.chunks[lo][1];
    for (let k = 0; k < blocks.length; k++) {
      const len = blockLength(blocks[k]);
      // Inside a long paragraph, the page with that character, not the one where the paragraph starts.
      if (n + len > target) return { b: this.chunks[lo][0] + k, o: Math.floor(target - n) };
      n += len;
    }
    return { b: this.chunks[lo][0] + blocks.length - 1, o: 0 };
  }

  /** The table of contents entry a block falls under. */
  chapterAt(block: number): TocEntry | undefined {
    let found: TocEntry | undefined;
    for (const t of this.toc) {
      if (t.b <= block) found = t;
      else break;
    }
    return found;
  }

  /** Known size of an image (after imageInfo resolved), for synchronous layout. */
  knownImage(key: string): ImageInfo | null | undefined {
    return this.imageSizes.get(key);
  }

  /** Resolve an image key to a file URI and pixel size, extracting it on first use. */
  imageInfo(key: string): Promise<ImageInfo | null> {
    let p = this.images.get(key);
    if (!p) {
      p = this.resolveImage(key)
        .then((uri) => (uri ? getSize(uri) : null))
        .catch(() => null)
        .then((info) => {
          this.imageSizes.set(key, info);
          return info;
        });
      this.images.set(key, p);
    }
    return p;
  }

  private async resolveImage(key: string): Promise<string | null> {
    const ref = this.manifest?.images[key];
    if (ref && 'file' in ref) return imageFile(this.entry.id, ref.file).uri;
    const safe = key.replace(/[^A-Za-z0-9._-]/g, '_');
    if (ref && 'pdb' in ref) {
      const out = imageFile(this.entry.id, `p_${safe}.${ref.ext}`);
      if (!out.exists) out.write(this.source().read(ref.pdb[0], ref.pdb[1]));
      return out.uri;
    }
    if (ref && 'zip' in ref) {
      const out = imageFile(this.entry.id, `z_${safe}.${ref.ext}`);
      if (!out.exists) {
        const [offset, csize, size, method] = ref.zip;
        out.write(readZipData(this.source(), offset, csize, size, method));
      }
      return out.uri;
    }
    // Still converting: look the image up directly.
    for (const ext of ['jpg', 'png', 'gif']) {
      const f = imageFile(this.entry.id, `b_${safe}.${ext}`);
      if (f.exists) return f.uri;
    }
    const zip = this.archive();
    const e = zip?.find(key);
    if (zip && e) {
      const ext = /\.([a-z0-9]{2,5})$/i.exec(key)?.[1]?.toLowerCase() ?? 'jpg';
      const out = imageFile(this.entry.id, `z_${safe}.${ext}`);
      if (!out.exists) out.write(zip.read(e));
      return out.uri;
    }
    return null;
  }

  private source(): FileSource {
    if (!this.src) this.src = new FileSource(sourceFile(this.entry));
    return this.src;
  }

  private archive(): ZipArchive | null {
    if (this.zip === undefined) {
      try {
        const head = this.source().read(0, 2);
        this.zip = head[0] === 0x50 && head[1] === 0x4b ? ZipArchive.open(this.source()) : null;
      } catch {
        this.zip = null;
      }
    }
    return this.zip;
  }

  close() {
    this.src?.close();
    this.src = null;
    this.zip = undefined;
  }
}

function getSize(uri: string): Promise<ImageInfo> {
  return new Promise((resolve, reject) =>
    Image.getSize(
      uri,
      (width, height) => resolve({ uri, width, height }),
      (e) => reject(e),
    ),
  );
}
