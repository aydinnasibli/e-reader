// Self-update for the Android APK. CI publishes each build as a GitHub
// release tagged build-<n>; the app compares <n> with its own build number,
// downloads the newer APK and hands it to Android's installer.

import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

export const CURRENT_BUILD: number = Number(Constants.expoConfig?.extra?.buildNumber ?? 0);
const REPO: string = Constants.expoConfig?.extra?.updateRepo ?? 'aydinnasibli/e-reader';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** After a failed automatic check (no connection, say), the next one comes this much sooner. */
const RETRY_AFTER_MS = 15 * 60 * 1000;
/** Android's networking waits forever by default: a check that takes longer has failed. */
const CHECK_TIMEOUT_MS = 20_000;
/** Room left on the phone besides the download itself (installing unpacks it). */
const SPARE_BYTES = 30 * 1024 * 1024;
// FLAG_GRANT_READ_URI_PERMISSION, so the installer can read our file.
const GRANT_READ = 1;

export interface AvailableUpdate {
  build: number;
  url: string;
  size: number;
  notes: string;
  /** SHA-256 of the APK as GitHub reports it (hex), to check the download against. */
  sha256?: string;
}

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  /** `tried`: the installer was opened and the app is still the old version. */
  | { kind: 'available'; update: AvailableUpdate; tried?: boolean }
  | { kind: 'downloading'; update: AvailableUpdate; progress: number }
  | { kind: 'installing'; update: AvailableUpdate }
  | { kind: 'error'; message: string; update?: AvailableUpdate };

/** Only real Android builds made by CI can update themselves (not Expo Go). */
export function canSelfUpdate() {
  return Platform.OS === 'android' && Constants.executionEnvironment !== ExecutionEnvironment.StoreClient && CURRENT_BUILD > 0;
}

let state: UpdateState = { kind: 'idle' };
let lastCheck = 0;
/** "Not now" on this build: not offered again by the automatic checks until the app restarts or a newer one comes. */
let snoozed = 0;
const listeners = new Set<() => void>();

function set(s: UpdateState) {
  state = s;
  listeners.forEach((l) => l());
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

async function fetchLatest(): Promise<AvailableUpdate | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: ctl.signal,
    });
    if (!res.ok) throw new UpdateError(res.status === 403 || res.status === 429 ? 'busy' : 'server');
    const rel = (await res.json()) as {
      tag_name?: string;
      body?: string;
      assets?: { name: string; browser_download_url: string; size: number; digest?: string | null }[];
    };
    const build = Number(/^build-(\d+)$/.exec(rel.tag_name ?? '')?.[1] ?? 0);
    const apk = rel.assets?.find((a) => a.name.endsWith('.apk'));
    if (!build || !apk) return null;
    const sha256 = /^sha256:([0-9a-f]{64})$/i.exec(apk.digest ?? '')?.[1]?.toLowerCase();
    return { build, url: apk.browser_download_url, size: apk.size, notes: rel.body ?? '', ...(sha256 ? { sha256 } : {}) };
  } finally {
    clearTimeout(timer);
  }
}

type Problem = 'offline' | 'busy' | 'server' | 'incomplete' | 'installer' | 'space' | 'damaged';

/** A problem with a message written for people. */
class UpdateError extends Error {
  constructor(readonly problem: Problem) {
    super(problem);
  }
}

const MESSAGES: Record<Problem, string> = {
  offline: 'Couldn’t connect. Check the internet connection and try again.',
  busy: 'The update server is busy right now. Try again in a while.',
  server: 'Couldn’t check for updates right now. Try again later.',
  incomplete: 'The download didn’t finish. Please try again.',
  installer: 'Couldn’t open Android’s installer. Please try again.',
  space: 'There isn’t enough free space on the phone for the update. Free some up and try again.',
  damaged: 'The download came out damaged. Please try again.',
};

const NO_SPACE = /ENOSPC|no space left|not enough (free )?space|disk full|storage full/i;

/** What to tell the person about a failed check or download. */
export function updateErrorMessage(e: unknown, during: 'check' | 'download' | 'install'): string {
  if (e instanceof UpdateError) return MESSAGES[e.problem];
  if (NO_SPACE.test(String(e))) return MESSAGES.space;
  if (during === 'install') return MESSAGES.installer;
  // fetch and downloads fail with a TypeError or a native error when there's no connection.
  return MESSAGES.offline;
}

/** Free space on the phone in bytes (Infinity when it can't be told). */
function freeSpace(): number {
  try {
    const n = Paths.availableDiskSpace;
    return typeof n === 'number' && Number.isFinite(n) ? n : Infinity;
  } catch {
    return Infinity;
  }
}

const busy = () => state.kind === 'downloading' || state.kind === 'installing';

/**
 * Look for a newer build. Quiet by default (no error shown); `manual` checks
 * always run and report problems in the update bar.
 */
export async function checkForUpdate(manual = false): Promise<'available' | 'none' | 'error' | 'busy'> {
  if (!canSelfUpdate()) return 'none';
  if (busy()) return 'busy';
  if (!manual && Date.now() - lastCheck < CHECK_EVERY_MS) return state.kind === 'available' ? 'available' : 'none';
  lastCheck = Date.now();
  if (manual) set({ kind: 'checking' });
  try {
    const latest = await fetchLatest();
    // An update may have started meanwhile; don't replace its progress.
    if (busy()) return 'busy';
    if (latest && latest.build > CURRENT_BUILD) {
      if (!manual && latest.build === snoozed) {
        set({ kind: 'idle' });
        return 'none';
      }
      set({ kind: 'available', update: latest });
      return 'available';
    }
    set({ kind: 'idle' });
    return 'none';
  } catch (e) {
    // No connection now says nothing about later: checked again soon, not in six hours.
    if (!manual) lastCheck = Date.now() - CHECK_EVERY_MS + RETRY_AFTER_MS;
    if (busy()) return 'busy';
    set(manual ? { kind: 'error', message: updateErrorMessage(e, 'check') } : { kind: 'idle' });
    return 'error';
  }
}

const apkName = (build: number) => `nec-reader-${build}.apk`;

/** Delete downloaded installers of this build or older (they've been installed). */
export function cleanOldDownloads() {
  if (!canSelfUpdate()) return;
  try {
    for (const f of new Directory(Paths.cache).list()) {
      const n = f instanceof File ? /^nec-reader-(\d+)\.apk$/.exec(f.name) : null;
      if (n && Number(n[1]) <= CURRENT_BUILD) f.delete();
    }
  } catch {
    // the cache is the system's to clear anyway
  }
}

/** The downloaded APK is the one GitHub published: its size, and its SHA-256 when GitHub gives one. */
async function verified(file: File, update: AvailableUpdate): Promise<boolean> {
  if (!file.exists || (update.size > 0 && file.size !== update.size)) return false;
  if (!update.sha256) return true;
  try {
    return (await file.digest('SHA-256')).toLowerCase() === update.sha256;
  } catch {
    return false;
  }
}

function remove(file: File) {
  try {
    if (file.exists) file.delete();
  } catch {
    // the cache is the system's to clear anyway
  }
}

/** Download the APK (unless a complete copy is already here) and open Android's installer for it. */
export async function installUpdate(update: AvailableUpdate) {
  if (busy()) return;
  let step: 'download' | 'install' = 'download';
  const dest = new File(Paths.cache, apkName(update.build));
  try {
    set({ kind: 'downloading', update, progress: 0 });
    let file = dest;
    // Downloaded before (the installer was closed, or it failed to open): used as it is.
    if (!(await verified(dest, update))) {
      remove(dest);
      if (update.size > 0 && freeSpace() < update.size + SPARE_BYTES) throw new UpdateError('space');
      file = await File.downloadFileAsync(update.url, dest, {
        onProgress: ({ bytesWritten, totalBytes }) => {
          const total = totalBytes > 0 ? totalBytes : update.size;
          set({ kind: 'downloading', update, progress: total ? bytesWritten / total : 0 });
        },
      });
      if (update.size > 0 && file.size !== update.size) throw new UpdateError('incomplete');
      if (!(await verified(file, update))) throw new UpdateError('damaged');
    }
    step = 'install';
    set({ kind: 'installing', update });
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: file.contentUri,
      flags: GRANT_READ,
      type: 'application/vnd.android.package-archive',
    });
    // Still here: the person backed out, or Android asked to allow installs
    // from this app first. Offer the update again, with what to do.
    set({ kind: 'available', update, tried: true });
  } catch (e) {
    // A download that failed part way (Android writes straight into the file) isn't kept.
    if (step === 'download') remove(dest);
    set({ kind: 'error', message: updateErrorMessage(e, step), update });
  }
}

/** "Not now": hide the offer of this build. */
export function snoozeUpdate() {
  if (state.kind !== 'available') return;
  snoozed = state.update.build;
  set({ kind: 'idle' });
}

export function dismissUpdateError() {
  set(state.kind === 'error' && state.update ? { kind: 'available', update: state.update } : { kind: 'idle' });
}
