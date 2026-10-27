// Reader-side access to a converted book: loads chunks on demand (keeping a
// small cache), maps positions to percentages, and extracts images lazily.

import { File, FileMode } from 'expo-file-system';
import { Image } from 'react-native';
import { guessLanguage } from '@/engine/language';
import type { Block, ChunkFile, Manifest, Position, TocEntry } from '@/engine/types';
import { blockLength, blockText } from '@/engine/types';
import { concatBytes } from '@/engine/io';
import { MAX_READ_BYTES, ZipArchive, type ZipEntry, readZipData } from '@/engine/zip';
import { type BookEntry, type LiveBook, sourceFile } from '@/lib/library';
import { FileSource, chunkFile, imageFile, safeImageName } from '@/lib/storage';
import type { Breather } from './breather';
import { svgSize } from './svgSize';
import { joinsBefore } from './web/html';

const CACHE_CHUNKS = 12;

export interface ImageInfo {
  uri: string;
  width: number;
  height: number;
}

export class BookData {
  chunks: [number, number][] = [];
  /** Page space of each chunk (see Manifest.weights); null for books converted before weights existed. */
  weights: number[] | null = null;
  /** The chunks that start a chapter (Manifest.opens); undefined for books converted before the converter told them. */
  opens: readonly number[] | undefined;
  totalBlocks = 0;
  totalChars = 0;
  /** True once conversion has finished. */
  complete = false;
  /** Conversion progress while processing (0..1). */
  progress = 1;
  toc: TocEntry[] = [];
  manifest: Manifest | null = null;

  private cache = new Map<number, Block[]>();
  /** Chunks the reader shows: never dropped from the cache (their text is read from it at any time). */
  private kept = new Set<number>();
  private loading = new Map<number, Promise<Block[]>>();
  private src: FileSource | null = null;
  private zip: ZipArchive | null | undefined;
  private images = new Map<string, Promise<ImageInfo | null>>();
  private imageSizes = new Map<string, ImageInfo | null>();

  constructor(readonly entry: BookEntry) {}

  setManifest(m: Manifest) {
    this.manifest = m;
    this.chunks = m.chunks;
    this.weights = m.weights?.length === m.chunks.length ? m.weights : null;
    this.opens = m.opens;
    this.totalBlocks = m.totalBlocks;
    this.totalChars = m.totalChars;
    this.toc = m.toc;
    this.complete = true;
    this.progress = 1;
  }

  setLive(live: LiveBook) {
    if (this.complete) return;
    this.chunks = live.chunks;
    this.weights = live.weights?.length === live.chunks.length ? live.weights : null;
    this.opens = live.opens;
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

  /** What page numbers are counted in: the converter's weights, or characters for books without them. */
  get weightUnit(): 'w' | 'c' {
    return this.weights ? 'w' : 'c';
  }

  /** How much page space chunk `i` takes (see weightUnit). */
  chunkWeight(i: number): number {
    return this.weights ? (this.weights[i] ?? 0) : this.chunkChars(i);
  }

  /** The weight of every chunk converted so far. */
  chunkWeights(): number[] {
    return this.weights ?? this.chunks.map((_, i) => this.chunkChars(i));
  }

  /** The whole book's weight, estimated from progress while it's still converting. */
  get estimatedWeight(): number {
    let known = 0;
    for (let i = 0; i < this.chunks.length; i++) known += this.chunkWeight(i);
    if (this.complete) return known;
    return this.progress > 0.01 ? known / this.progress : known * 10;
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

  /**
   * Whether chunk `i` goes on from the one before on its last page (page
   * mode): the two were cut apart only for size, in the middle of a chapter.
   */
  joins(i: number): boolean {
    return joinsBefore(i, (x) => this.chunkChars(x), (x) => this.chunkEnd(x) - this.chunkStart(x), this.opens);
  }

  /** The chunk holding character `n` of the book. */
  chunkOfChar(n: number): number {
    let lo = 0;
    let hi = this.chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.chunks[mid][1] <= n) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  /** How far into its chunk a position is (0..1), in characters. */
  fractionInChunk(pos: Position): number {
    const c = this.chunkOf(pos.b);
    const chars = this.chunkChars(c);
    return chars > 0 ? Math.min(1, Math.max(0, (this.charOffset(pos) - (this.chunks[c]?.[1] ?? 0)) / chars)) : 0;
  }

  /**
   * The block at a fraction of the book, at once, without reading anything:
   * exact to the chunk, estimated inside it (for labels while the slider is dragged).
   */
  blockAtFraction(fraction: number): number {
    if (!this.chunks.length) return 0;
    const target = Math.max(0, Math.min(this.totalChars - 1, fraction * this.estimatedChars));
    const c = this.chunkOfChar(target);
    const chars = this.chunkChars(c);
    const blocks = this.chunkEnd(c) - this.chunkStart(c);
    const f = chars > 0 ? (target - this.chunks[c][1]) / chars : 0;
    return this.chunkStart(c) + Math.min(Math.max(0, blocks - 1), Math.floor(f * blocks));
  }

  cached(i: number): Block[] | undefined {
    return this.cache.get(i);
  }

  block(b: number): Block | undefined {
    const i = this.chunkOf(b);
    return this.cache.get(i)?.[b - this.chunkStart(i)];
  }

  /** The chunks the reader shows now: kept in memory until it shows others. */
  keep(chunks: Iterable<number>) {
    this.kept = new Set(chunks);
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

  /**
   * Load a chunk the reader doesn't need to go on (measuring a layout, the
   * place a chip goes back to): a damaged one fails here, quietly, rather
   * than stop the book (onError).
   */
  tryLoadChunk(i: number): Promise<Block[]> {
    return this.readChunk(i);
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
          this.trim();
          return blocks;
        });
      p.catch(() => this.loading.delete(i));
      this.loading.set(i, p);
    }
    return p;
  }

  /** Drop the chunks used longest ago, beyond the cache's size; never the ones the reader shows. */
  private trim() {
    for (const c of this.cache.keys()) {
      if (this.cache.size <= CACHE_CHUNKS) break;
      if (!this.kept.has(c)) this.cache.delete(c);
    }
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
    const lo = this.chunkOfChar(target);
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

  /**
   * The language of the book's text, guessed from the chunk at `at` (books
   * converted before languages were worked out, until converted again);
   * undefined when the text doesn't tell.
   */
  async guessLanguage(at: Position): Promise<string | undefined> {
    if (!this.chunks.length) return undefined;
    const blocks = await this.loadChunk(Math.min(this.chunkOf(at.b), this.chunks.length - 1));
    let sample = '';
    for (const b of blocks) {
      if (sample.length > 6000) break;
      if (b.r) sample += blockText(b) + '\n';
    }
    return guessLanguage(sample);
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

  /**
   * Resolve an image key to a file URI and pixel size, extracting it on first
   * use. While the book is still being converted a picture may not be there
   * yet (FB2 keeps them at the end of the file): that isn't remembered, so
   * it's looked for again next time. `pause`: one taken out of the book's
   * ZIP for a chunk made in the background comes out in slices, with pauses.
   */
  imageInfo(key: string, pause?: Breather): Promise<ImageInfo | null> {
    let p = this.images.get(key);
    if (!p) {
      const final = this.complete;
      p = this.resolveImage(key, pause)
        .then((uri) => (uri ? sizeOf(uri) : null))
        .catch(() => null)
        .then((info) => {
          if (info || final) this.imageSizes.set(key, info);
          else this.images.delete(key);
          return info;
        });
      this.images.set(key, p);
    }
    return p;
  }

  private async resolveImage(key: string, pause?: Breather): Promise<string | null> {
    const ref = this.manifest?.images[key];
    if (ref && 'file' in ref) return imageFile(this.entry.id, ref.file).uri;
    const safe = safeImageName(key);
    if (ref && 'pdb' in ref) {
      const out = imageFile(this.entry.id, `p_${safe}.${ref.ext}`);
      if (!out.exists) out.writeSync(this.source().read(ref.pdb[0], ref.pdb[1]));
      return out.uri;
    }
    if (ref && 'zip' in ref) {
      const out = imageFile(this.entry.id, `z_${safe}.${ref.ext}`);
      if (out.exists) return out.uri;
      const [offset, compressedSize, size, method] = ref.zip;
      // Wanted on screen: read at once, as it is; in the background, in slices.
      const zip = pause && this.archive();
      out.writeSync(zip ? await unzip(zip, { name: key, offset, compressedSize, size, method }, pause) : readZipData(this.source(), offset, compressedSize, size, method));
      return out.uri;
    }
    // Still converting: look the image up directly. FB2 pictures are already
    // written, named after their id (see fb2.ts).
    for (const ext of ['jpg', 'png', 'gif', 'svg']) {
      const f = imageFile(this.entry.id, `b_${key.replace(/[^A-Za-z0-9._-]/g, '_')}.${ext}`);
      if (f.exists) return f.uri;
    }
    const zip = this.archive();
    const e = zip?.find(key);
    if (zip && e) {
      const ext = /\.([a-z0-9]{2,5})$/i.exec(key)?.[1]?.toLowerCase() ?? 'jpg';
      const out = imageFile(this.entry.id, `z_${safe}.${ext}`);
      if (!out.exists) out.writeSync(pause ? await unzip(zip, e, pause) : zip.read(e));
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

/**
 * A picture taken out of the book's ZIP a slice at a time, with `pause`
 * between them (in the background: a big one doesn't hold up the app while
 * the next chunk is prepared). Written whole once it's all there.
 */
async function unzip(zip: ZipArchive, e: ZipEntry, pause?: Breather): Promise<Uint8Array> {
  if (e.size > MAX_READ_BYTES || e.compressedSize > MAX_READ_BYTES) throw new Error(`Picture too big: ${e.name}`);
  const parts: Uint8Array[] = [];
  let n = 0;
  await zip.stream(
    e,
    (bytes) => {
      parts.push(bytes);
      n += bytes.length;
    },
    pause,
  );
  return concatBytes(parts, n);
}

/** A picture's size: SVGs from their own markup (the image loader can't open them), others from the loader. */
async function sizeOf(uri: string): Promise<ImageInfo | null> {
  if (/\.svg$/i.test(uri)) {
    const size = svgSize(fileHead(uri));
    return size ? { uri, ...size } : null;
  }
  return new Promise((resolve, reject) =>
    Image.getSize(
      uri,
      (width, height) => resolve({ uri, width, height }),
      (e) => reject(e),
    ),
  );
}

/** The start of a file, as text (enough for an SVG's opening tag). */
function fileHead(uri: string): string {
  const h = new File(uri).open(FileMode.ReadOnly);
  try {
    const bytes = h.readBytesSync(Math.min(8192, h.size ?? 8192));
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  } finally {
    h.close();
  }
}
