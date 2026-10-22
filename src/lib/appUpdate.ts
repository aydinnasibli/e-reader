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
// FLAG_GRANT_READ_URI_PERMISSION, so the installer can read our file.
const GRANT_READ = 1;

export interface AvailableUpdate {
  build: number;
  url: string;
  size: number;
  notes: string;
}

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; update: AvailableUpdate }
  | { kind: 'downloading'; update: AvailableUpdate; progress: number }
  | { kind: 'installing'; update: AvailableUpdate }
  | { kind: 'error'; message: string; update?: AvailableUpdate };

/** Only real Android builds made by CI can update themselves (not Expo Go). */
export function canSelfUpdate() {
  return Platform.OS === 'android' && Constants.executionEnvironment !== ExecutionEnvironment.StoreClient && CURRENT_BUILD > 0;
}

let state: UpdateState = { kind: 'idle' };
let lastCheck = 0;
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
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const rel = (await res.json()) as { tag_name?: string; body?: string; assets?: { name: string; browser_download_url: string; size: number }[] };
  const build = Number(/^build-(\d+)$/.exec(rel.tag_name ?? '')?.[1] ?? 0);
  const apk = rel.assets?.find((a) => a.name.endsWith('.apk'));
  if (!build || !apk) return null;
  return { build, url: apk.browser_download_url, size: apk.size, notes: rel.body ?? '' };
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
      set({ kind: 'available', update: latest });
      return 'available';
    }
    set({ kind: 'idle' });
    return 'none';
  } catch (e) {
    if (busy()) return 'busy';
    set(manual ? { kind: 'error', message: e instanceof Error ? e.message : String(e) } : { kind: 'idle' });
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

/** Download the APK and open Android's installer for it. */
export async function installUpdate(update: AvailableUpdate) {
  if (busy()) return;
  try {
    set({ kind: 'downloading', update, progress: 0 });
    const dest = new File(Paths.cache, apkName(update.build));
    if (dest.exists) dest.delete();
    const file = await File.downloadFileAsync(update.url, dest, {
      onProgress: ({ bytesWritten, totalBytes }) => {
        const total = totalBytes > 0 ? totalBytes : update.size;
        set({ kind: 'downloading', update, progress: total ? bytesWritten / total : 0 });
      },
    });
    if (update.size > 0 && file.size !== update.size) {
      file.delete();
      throw new Error('The download was incomplete. Please try again.');
    }
    set({ kind: 'installing', update });
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: file.contentUri,
      flags: GRANT_READ,
      type: 'application/vnd.android.package-archive',
    });
    // If the person backs out of the installer, offer the update again.
    set({ kind: 'available', update });
  } catch (e) {
    set({ kind: 'error', message: e instanceof Error ? e.message : String(e), update });
  }
}

export function dismissUpdateError() {
  set(state.kind === 'error' && state.update ? { kind: 'available', update: state.update } : { kind: 'idle' });
}
