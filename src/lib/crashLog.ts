// Errors that closed the app or broke a screen, kept on the phone in
// crashes.json so they can be read and shared later (library → View → Crash
// log). Nothing is sent anywhere. Crashes inside native code (Java, Kotlin,
// Objective-C) never reach JavaScript and aren't recorded.

import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import { useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { readJson, saveJson } from './storage';

/**
 * fatal: closed the app · screen: a screen showed its error page instead ·
 * error: reported as not fatal, the app went on · promise: a failed async
 * job nobody waited for (release builds only; development shows a warning).
 */
export type CrashKind = 'fatal' | 'screen' | 'error' | 'promise';

export interface Crash {
  at: number;
  kind: CrashKind;
  message: string;
  stack?: string;
  /** The screen that was open (its route). */
  screen?: string;
  build: number;
  /** The same error again soon after: counted instead of listed again. */
  count?: number;
  /** Already pointed out after a restart. */
  seen?: boolean;
}

const KEEP = 30;
const STACK_LIMIT = 4000;
/** The same error within this time counts as a repeat. */
const REPEAT_MS = 60_000;
const BUILD = Number(Constants.expoConfig?.extra?.buildNumber ?? 0);

const file = () => new File(Paths.document, 'crashes.json');
let crashes: Crash[] | null = null;
let screen: string | undefined;
const listeners = new Set<() => void>();

function all(): Crash[] {
  if (!crashes) {
    const saved = readJson<Crash[]>(file());
    crashes = Array.isArray(saved) ? saved : [];
  }
  return crashes;
}

function set(next: Crash[]) {
  crashes = next.slice(-KEEP);
  saveJson(file(), crashes);
  listeners.forEach((l) => l());
}

/** The screen now open, noted with the next crash. */
export function setCrashScreen(path: string) {
  screen = path;
}

function describe(error: unknown): { message: string; stack?: string } {
  if (error && typeof error === 'object' && 'message' in error) {
    const e = error as { name?: unknown; message?: unknown; stack?: unknown };
    const name = typeof e.name === 'string' && e.name ? e.name : 'Error';
    return { message: `${name}: ${String(e.message)}`, ...(typeof e.stack === 'string' ? { stack: e.stack.slice(0, STACK_LIMIT) } : {}) };
  }
  try {
    return { message: typeof error === 'string' ? error : (JSON.stringify(error) ?? String(error)) };
  } catch {
    return { message: String(error) };
  }
}

/** Keep an error in the log. Never throws: it runs while the app is going down. */
export function recordCrash(kind: CrashKind, error: unknown) {
  try {
    const list = all();
    const entry: Crash = { at: Date.now(), kind, ...describe(error), ...(screen ? { screen } : {}), build: BUILD };
    // While developing, say so at once too.
    if (typeof __DEV__ !== 'undefined' && __DEV__ && process.env.NODE_ENV !== 'test') console.warn(`[crash log] ${kind}: ${entry.message}`);
    const last = list[list.length - 1];
    if (last && last.kind === kind && last.message === entry.message && entry.at - last.at < REPEAT_MS) {
      set([...list.slice(0, -1), { ...last, at: entry.at, count: (last.count ?? 1) + 1 }]);
    } else set([...list, entry]);
  } catch {
    // nothing more can be done
  }
}

/** Record the error a screen's error page is showing. */
export function useRecordScreenError(error: Error) {
  useEffect(() => recordCrash('screen', error), [error]);
}

export function useCrashes(): Crash[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    all,
  );
}

export function clearCrashes() {
  set([]);
}

/** The latest crash that closed the app and hasn't been pointed out yet. Marks them all as pointed out. */
export function takeUnseenFatal(): Crash | undefined {
  const list = all();
  const unseen = list.filter((c) => c.kind === 'fatal' && !c.seen);
  if (!unseen.length) return undefined;
  set(list.map((c) => (c.kind === 'fatal' && !c.seen ? { ...c, seen: true } : c)));
  return unseen[unseen.length - 1];
}

const KIND_LABELS: Record<CrashKind, string> = {
  fatal: 'closed the app',
  screen: 'error page shown',
  error: 'error, app kept running',
  promise: 'failed in the background',
};

/** The log as text to share, newest first. */
export function crashReport(list: Crash[] = all()): string {
  const head = `Nec e-book reader 1.0.${BUILD} · ${Platform.OS} ${Platform.Version}`;
  const items = [...list].reverse().map((c) => {
    const meta = [new Date(c.at).toISOString(), KIND_LABELS[c.kind], c.screen, c.build !== BUILD ? `build ${c.build}` : undefined, c.count ? `${c.count} times` : undefined];
    // Hermes stacks start with the message itself.
    const body = c.stack?.startsWith(c.message) ? c.stack : [c.message, c.stack].filter(Boolean).join('\n');
    return `--- ${meta.filter(Boolean).join(' · ')}\n${body}`;
  });
  return [head, ...items].join('\n\n');
}

type Handler = (error: unknown, isFatal?: boolean) => void;
interface Globals {
  ErrorUtils?: { getGlobalHandler(): Handler | undefined; setGlobalHandler(h: Handler): void };
  HermesInternal?: {
    enablePromiseRejectionTracker?(options: { allRejections: boolean; onUnhandled(id: number, error: unknown): void; onHandled(id: number): void }): void;
  };
}

let installed = false;

/**
 * Record every error nothing else caught, then let React Native handle it as
 * before. `beforeFatal` runs when one is about to close the app, to save what
 * is pending.
 */
export function installCrashHandlers(beforeFatal?: () => void, dev = typeof __DEV__ !== 'undefined' && __DEV__) {
  if (installed) return;
  installed = true;
  const g = globalThis as Globals;
  const previous = g.ErrorUtils?.getGlobalHandler();
  g.ErrorUtils?.setGlobalHandler((error, isFatal) => {
    recordCrash(isFatal ? 'fatal' : 'error', error);
    if (isFatal) {
      try {
        beforeFatal?.();
      } catch {
        // the crash itself matters more
      }
    }
    previous?.(error, isFatal);
  });
  // Release builds don't track promises nobody handled at all; development
  // builds already show them as warnings, so leave those alone.
  if (!dev) {
    g.HermesInternal?.enablePromiseRejectionTracker?.({
      allRejections: true,
      onUnhandled: (_id, error) => recordCrash('promise', error),
      onHandled: () => {},
    });
  }
}
