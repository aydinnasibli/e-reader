// A book's new conversion (by a newer converter, complete in next/) put in
// place of its old one, its marks and reading place moved along (remap.ts).
// The swap is planned in next/commit.json first, so that a swap cut short by
// the app being killed is finished at the next start (library.ts loadLibrary).

import { Directory, File } from 'expo-file-system';
import { strToU8 } from 'fflate';
import { type ChunkFile, ENGINE_VERSION, type Manifest, type Position } from '@/engine/types';
import { type Annotations, getAnnotations, replaceAnnotations } from './annotations';
import { hashBytes } from './fingerprint';
import { isRecord } from './guards';
import { type BookEntry, flushLibrary, getBook, isBookOpen, loadManifest, readManifest, swapsAreHeld, updateBook } from './libraryStore';
import { type Conversion, moveMarks, movedPlace, ownMarks, withMoved } from './remap';
import { bookDir, manifestFile, nextDir, readJson, removeJson, savedCopies, writeJson } from './storage';

/** Read access to a conversion in `root` (a book's folder or its next/). */
export function conversionAt(root: Directory, m: Manifest): Conversion {
  return {
    chunks: m.chunks,
    totalBlocks: m.totalBlocks,
    totalChars: m.totalChars,
    read: async (i) => (JSON.parse(await new File(root, 'c', `${i}.json`).text()) as ChunkFile).b,
  };
}

/** Read access to a book's conversion (for finding its marks by their text), if it has one. */
export function bookConversion(id: string, m: Manifest | null = loadManifest(id)): Conversion | null {
  return m ? conversionAt(bookDir(id), m) : null;
}

/** The reader's page numbers for a book (reader-owned), worked out for the conversion it has. */
export const pagesFile = (id: string) => new File(bookDir(id), 'pages.json');

/** Delete a file written by writeJson and its saved copies; unlike removeJson(), a failure throws. */
function deleteSaved(file: File) {
  for (const f of [...savedCopies(file), file]) if (f.exists) f.delete();
}

/**
 * Keep a copy of a book's annotations as they are, just before they are
 * moved off conversion version `v` (annotations.v1.json).
 */
export function keepAnnotations(id: string, v: number | undefined) {
  try {
    const ann = new File(bookDir(id), 'annotations.json');
    if (ann.exists) ann.copySync(new File(bookDir(id), `annotations.v${v ?? 1}.json`), { overwrite: true });
  } catch {
    // the copy is a precaution; the marks themselves move on
  }
}

/** The conversion in next/, if one by this converter is complete there (its manifest is written last). */
export function finishedNext(id: string): Manifest | null {
  const m = readManifest(new File(nextDir(id), 'manifest.json'));
  return m && m.v === ENGINE_VERSION ? m : null;
}

export function dropNext(id: string) {
  try {
    const d = nextDir(id);
    if (d.exists) d.delete();
  } catch {
    // tried again next time
  }
}

/** What finishSwap() does, saved before it starts so that it can be finished after a restart. */
interface SwapPlan {
  /** Converter versions of the conversion replaced and of the one taking over. */
  from?: number;
  to: number;
  annotations: Annotations;
  patch: Partial<BookEntry>;
  /** The marks (marksKey) and reading place the plan was made from, and the marks it makes. */
  basis: string;
  place?: Position;
  result: string;
}

const isPlan = (v: unknown) =>
  isRecord(v) &&
  typeof v.to === 'number' &&
  typeof v.basis === 'string' &&
  typeof v.result === 'string' &&
  isRecord(v.patch) &&
  isRecord(v.annotations) &&
  Array.isArray(v.annotations.highlights) &&
  Array.isArray(v.annotations.bookmarks);

const planFile = (id: string) => new File(nextDir(id), 'commit.json');
const dropPlan = (id: string) => removeJson(planFile(id));

/** A book's marks as one value, to tell whether they are still what a plan was made from. */
function marksKey(a: Annotations): string {
  const lines = (list: object[]) =>
    list
      .map((x) => JSON.stringify(x, Object.keys(x).sort()))
      .sort()
      .join('\n');
  return hashBytes(strToU8(`${lines(a.highlights)}\n--\n${lines(a.bookmarks)}`));
}

const samePosition = (a?: Position, b?: Position) => (!a && !b) || (!!a && !!b && a.b === b.b && a.o === b.o);

/**
 * Put a book's new conversion (complete in next/) in place of its old one,
 * its marks moved along. Marks are found on both conversions in the
 * background; the swap itself is done in one go after checking that nothing
 * changed meanwhile. Not while the book is open ('open': once it's closed).
 */
export async function swapIn(id: string, m: Manifest, pause: () => Promise<void>): Promise<'done' | 'open' | 'busy'> {
  const fresh = conversionAt(nextDir(id), m);
  for (let tries = 0; tries < 3; tries++) {
    const book = getBook(id);
    if (!book) return 'done';
    if (isBookOpen(id) || swapsAreHeld()) return 'open';
    const ann = getAnnotations(id);
    const old = loadManifest(id);
    const set = await ownMarks(old ? conversionAt(bookDir(id), old) : null, ann, book.position, book.percent, pause);
    const moved = await moveMarks(set, fresh, { toc: m.toc, pause });
    const now = getBook(id);
    if (!now) return 'done';
    if (isBookOpen(id) || swapsAreHeld()) return 'open';
    // A note edited or the place saved meanwhile: found again with the change.
    if (getAnnotations(id) !== ann || now.position !== book.position) continue;
    const place = movedPlace(now, set, moved);
    const cover = m.cover ? m.images[m.cover] : undefined;
    const annotations = withMoved(ann, set, moved);
    const plan: SwapPlan = {
      from: old?.v ?? now.engine,
      to: m.v,
      annotations,
      patch: {
        ...(place ? { position: place.position, percent: place.percent } : {}),
        ...(now.titleEdited ? {} : { title: m.title, author: m.author }),
        format: m.format,
        coverFile: cover && 'file' in cover ? cover.file : undefined,
        upgradeFailed: undefined,
      },
      basis: marksKey(ann),
      ...(now.position ? { place: now.position } : {}),
      result: marksKey(annotations),
    };
    // The manifest is complete (it may still be the .tmp of a save cut short): in place under its name.
    const nm = new File(nextDir(id), 'manifest.json');
    if (!nm.exists) writeJson(nm, m);
    writeJson(planFile(id), plan);
    if (finishSwap(id)) return 'done';
  }
  // Its marks keep changing (edited in Highlights & notes): another time.
  return 'busy';
}

/**
 * Carry out a swap planned in next/commit.json. Every step can run again: the
 * app may close at any point, and this runs again at the next start before
 * anything reads the book. Once the library says the book has the new
 * conversion, the rest was done before, so a plan is never carried out twice;
 * and it is only carried out on the marks and place it was made from (or
 * once its marks are saved): a plan that couldn't be carried out, followed
 * by more reading and new marks, is dropped and made again from those.
 * False: there was no plan to carry out.
 */
export function finishSwap(id: string): boolean {
  const plan = readJson<SwapPlan>(planFile(id), isPlan);
  if (!plan) return false;
  const book = getBook(id);
  if (book && book.engine !== plan.to) {
    const dir = bookDir(id);
    const next = nextDir(id);
    const marks = marksKey(getAnnotations(id));
    // Saved before the app closed: the rest follows.
    const saved = marks === plan.result;
    if (!saved && (marks !== plan.basis || !samePosition(book.position, plan.place))) {
      dropPlan(id);
      return false;
    }
    if (!saved) {
      keepAnnotations(id, plan.from);
      try {
        // The moved marks first: if they can't be saved (the phone is full),
        // nothing else has changed, and the plan is made again another time.
        replaceAnnotations(id, plan.annotations);
      } catch (e) {
        dropPlan(id);
        throw e;
      }
    }
    for (const name of ['c', 'img']) {
      const fresh = new Directory(next, name);
      if (!fresh.exists) continue;
      const old = new Directory(dir, name);
      if (old.exists) old.delete();
      fresh.moveSync(old);
    }
    const nm = new File(next, 'manifest.json');
    if (nm.exists) {
      // The old manifest's saved copies must not be read for the new chunks.
      for (const f of savedCopies(manifestFile(id))) if (f.exists) f.delete();
      nm.moveSync(manifestFile(id), { overwrite: true });
    }
    deleteSaved(pagesFile(id));
    updateBook(id, { ...plan.patch, engine: plan.to });
    flushLibrary();
  }
  // Done: the plan goes first (with its saved copies), so it can't be carried out again.
  dropPlan(id);
  dropNext(id);
  return true;
}
