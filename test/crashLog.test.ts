// Errors nothing else caught are kept on the phone (crashes.json): recorded
// before React Native's own handling runs, saved before the app closes, kept
// across restarts and pointed out once afterwards.

import { beforeEach, expect, it, vi } from 'vitest';

const disk = new Map<string, string>();

vi.mock('react-native', () => ({ Platform: { OS: 'android', Version: 36 } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { buildNumber: 42 } } } }));
vi.mock('expo-file-system', () => ({
  Paths: { document: 'doc' },
  File: class {
    path: string;
    constructor(...parts: string[]) {
      this.path = parts.join('/');
    }
  },
}));
vi.mock('@/lib/storage', () => ({
  readJson: (f: { path: string }) => (disk.has(f.path) ? JSON.parse(disk.get(f.path)!) : null),
  saveJson: (f: { path: string }, v: unknown) => {
    disk.set(f.path, JSON.stringify(v));
    return true;
  },
}));

type Handler = (e: unknown, fatal?: boolean) => void;
let handler: Handler | undefined;
let tracker: { onUnhandled(id: number, e: unknown): void } | undefined;
const rnHandler = vi.fn();

const load = async () => {
  vi.resetModules();
  return import('@/lib/crashLog');
};

beforeEach(() => {
  disk.clear();
  rnHandler.mockClear();
  handler = rnHandler;
  tracker = undefined;
  Object.assign(globalThis, {
    ErrorUtils: { getGlobalHandler: () => handler, setGlobalHandler: (h: Handler) => (handler = h) },
    HermesInternal: { enablePromiseRejectionTracker: (o: typeof tracker) => (tracker = o) },
  });
});

const saved = () => JSON.parse(disk.get('doc/crashes.json') ?? '[]');

it('a fatal error is saved, pending work is saved first, and React Native still handles it', async () => {
  const log = await load();
  const order: string[] = [];
  rnHandler.mockImplementation(() => order.push('react native'));
  log.installCrashHandlers(() => order.push(`saved pending, log has ${saved().length}`), false);
  log.setCrashScreen('/reader/abc');
  handler!(new TypeError("undefined is not an object (evaluating 'page.blocks')"), true);

  expect(order).toEqual(['saved pending, log has 1', 'react native']);
  expect(rnHandler).toHaveBeenCalledWith(expect.any(TypeError), true);
  expect(saved()).toMatchObject([{ kind: 'fatal', message: "TypeError: undefined is not an object (evaluating 'page.blocks')", screen: '/reader/abc', build: 42 }]);

  // "Restart": the next launch reads it back and points it out once.
  const again = await load();
  expect(again.takeUnseenFatal()?.message).toContain('page.blocks');
  expect(again.takeUnseenFatal()).toBeUndefined();
  expect(again.crashReport()).toMatch(/^Nec e-book reader 1\.0\.42 · android 36\n\n--- .* · closed the app · \/reader\/abc\nTypeError/);
});

it('promises nobody handled are recorded in release builds only', async () => {
  const log = await load();
  log.installCrashHandlers(undefined, true);
  expect(tracker).toBeUndefined();

  const release = await load();
  release.installCrashHandlers(undefined, false);
  tracker!.onUnhandled(1, new Error('Network request failed'));
  expect(saved()).toMatchObject([{ kind: 'promise', message: 'Error: Network request failed' }]);
});

it('the same error again soon after is counted, and the log keeps only the latest 30', async () => {
  const log = await load();
  for (let i = 0; i < 5; i++) log.recordCrash('error', new Error('same'));
  expect(saved()).toHaveLength(1);
  expect(saved()[0].count).toBe(5);

  for (let i = 0; i < 40; i++) log.recordCrash('screen', new Error(`error ${i}`));
  expect(saved()).toHaveLength(30);
  expect(saved()[29].message).toBe('Error: error 39');
});

it('anything thrown is recorded, and recording never throws', async () => {
  const log = await load();
  log.recordCrash('error', 'plain string');
  log.recordCrash('error', { code: 7 });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(() => log.recordCrash('error', circular)).not.toThrow();
  expect(saved().map((c: { message: string }) => c.message)).toEqual(['plain string', '{"code":7}', '[object Object]']);
  log.clearCrashes();
  expect(saved()).toEqual([]);
});
