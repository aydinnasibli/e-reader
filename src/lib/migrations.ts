// The version of how the app's own files are laid out (library.json,
// settings.json, shelves.json, stats.json, each book's annotations.json; see
// storage.ts), saved in storage.json. A change to any of them gets a new
// version and a step below that brings older files up to date. Steps run once,
// at start, before anything reads the files. (How books themselves are
// converted is versioned separately: ENGINE_VERSION in engine/types.ts.)

import { File, Paths } from 'expo-file-system';
import { recordCrash } from './crashLog';
import { readJson, writeJson } from './storage';

/** 1: the layout up to and including the first versioned build. */
export const STORAGE_VERSION = 1;

export interface MigrationStep {
  /** The version the files have after this step. */
  to: number;
  /**
   * Rewrites the files. Must cope with being run again on files it already
   * changed: the app can be killed halfway through.
   */
  run(): void;
}

/** Oldest first. */
const STEPS: MigrationStep[] = [];

const file = () => new File(Paths.document, 'storage.json');

export type MigrationResult = 'current' | 'migrated' | 'failed' | 'newer';

/** The app's own steps' result this start, once they have run (migrateOnce). */
let done: MigrationResult | null = null;

/**
 * Bring the saved files up to the current version. Files from before
 * versioning count as version 1. A step that throws is recorded in the crash
 * log and tried again next start; the steps before it stay done.
 */
export function migrateStorage(steps: MigrationStep[] = STEPS, latest = STORAGE_VERSION): MigrationResult {
  const result = run(steps, latest);
  if (steps === STEPS && latest === STORAGE_VERSION) done = result;
  return result;
}

function run(steps: MigrationStep[], latest: number): MigrationResult {
  const saved = readJson<{ version?: unknown }>(file());
  const start = typeof saved?.version === 'number' ? saved.version : 1;
  // Written by a newer build (the app was downgraded): leave them as they are.
  if (start > latest) return 'newer';
  let version = start;
  try {
    for (const step of steps) {
      if (step.to <= version || step.to > latest) continue;
      step.run();
      version = step.to;
      writeJson(file(), { version });
    }
    if (saved?.version !== version) writeJson(file(), { version });
  } catch (e) {
    recordCrash('error', e);
    return 'failed';
  }
  return version === start ? 'current' : 'migrated';
}

/**
 * migrateStorage() once per start, before the first file is read: the
 * library calls it on loading, which can come first from "Open with" (a cold
 * start by a shared file runs before the root layout); not again if it has run.
 */
export function migrateOnce(): MigrationResult {
  done ??= migrateStorage();
  return done;
}
