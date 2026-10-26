/// <reference types="jest" />
// Self-update messages are written for people, and "Not now" hides an offer.

import { renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { executionEnvironment: 'standalone', expoConfig: { extra: { buildNumber: 10, updateRepo: 'me/app' } } },
  ExecutionEnvironment: { StoreClient: 'storeClient' },
}));
jest.mock('expo-intent-launcher', () => ({ startActivityAsync: jest.fn(() => Promise.resolve({ resultCode: 0 })) }));
/** The app's cache: file uri -> bytes. */
const mockDisk = new Map<string, Uint8Array>();
const mockSpace = { free: 1e12 };
jest.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/');
    }
    get exists() {
      return mockDisk.has(this.uri);
    }
    get size() {
      return mockDisk.get(this.uri)?.length ?? 0;
    }
    get contentUri() {
      return 'content://provider/' + this.uri;
    }
    delete() {
      mockDisk.delete(this.uri);
    }
    async digest(algorithm: string) {
      return require('crypto').createHash(algorithm.replace('-', '').toLowerCase()).update(mockDisk.get(this.uri)!).digest('hex');
    }
    static downloadFileAsync = jest.fn();
  }
  return {
    File,
    Directory: class {
      list() {
        return [];
      }
    },
    Paths: {
      cache: { uri: 'cache' },
      get availableDiskSpace() {
        return mockSpace.free;
      },
    },
  };
});

Object.defineProperty(Platform, 'OS', { get: () => 'android' });
// Loaded after Platform is set: whether the app can update itself is decided from it.
const { checkForUpdate, snoozeUpdate, useUpdateState } = require('@/lib/appUpdate') as typeof import('@/lib/appUpdate');

const fetchMock = jest.fn();
(global as { fetch: unknown }).fetch = fetchMock;
const release = (build: number) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ tag_name: `build-${build}`, body: 'Notes', assets: [{ name: 'app.apk', browser_download_url: 'https://x/app.apk', size: 100 }] }),
});

/** The update state, read through the store the banner uses. */
async function state() {
  const hook = await renderHook(() => useUpdateState());
  await hook.unmount(); // just reading it; later changes needn't redraw anything
  return hook.result.current as { kind: string; message?: string };
}

it('no connection: says so in plain words', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
  expect(await checkForUpdate(true)).toBe('error');
  expect(await state()).toEqual({ kind: 'error', message: 'Couldn’t connect. Check the internet connection and try again.' });
});

it('the server refusing (rate limit): not a raw status code', async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
  await checkForUpdate(true);
  expect((await state()).message).toBe('The update server is busy right now. Try again in a while.');
});

it('"Not now" hides the offer from the automatic checks; checking from the menu shows it again', async () => {
  fetchMock.mockResolvedValue(release(11));
  expect(await checkForUpdate(true)).toBe('available');
  snoozeUpdate();
  expect((await state()).kind).toBe('idle');
  // The automatic check (on coming back to the app, hours later) doesn't bring it back...
  jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 7 * 60 * 60 * 1000);
  expect(await checkForUpdate()).toBe('none');
  expect((await state()).kind).toBe('idle');
  // ...a newer build does, and so does checking from the menu.
  fetchMock.mockResolvedValue(release(12));
  jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 14 * 60 * 60 * 1000);
  expect(await checkForUpdate()).toBe('available');
  snoozeUpdate();
  expect(await checkForUpdate(true)).toBe('available');
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// ---------- downloading the update ----------

const { installUpdate } = require('@/lib/appUpdate') as typeof import('@/lib/appUpdate');
const { File: MockFile } = require('expo-file-system') as { File: { downloadFileAsync: jest.Mock } };
const { startActivityAsync } = require('expo-intent-launcher') as { startActivityAsync: jest.Mock };
const APK = Uint8Array.from({ length: 4096 }, (_, i) => (i * 13) & 255);
const sha = (b: Uint8Array) => require('crypto').createHash('sha256').update(b).digest('hex') as string;
const update = { build: 11, url: 'https://github.com/x/releases/download/build-11/nec-reader.apk', size: APK.length, notes: '', sha256: sha(APK) };
const apkPath = 'cache/nec-reader-11.apk';

describe('downloading the update', () => {
  beforeEach(() => {
    mockDisk.clear();
    mockSpace.free = 1e12;
    MockFile.downloadFileAsync.mockReset();
    startActivityAsync.mockClear();
  });

  it('GitHub’s SHA-256 of the APK comes with the release, to check the download against', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ tag_name: 'build-12', assets: [{ name: 'nec-reader.apk', browser_download_url: 'https://x/a.apk', size: 9, digest: `sha256:${'AB'.repeat(32)}` }] }),
    });
    await checkForUpdate(true);
    expect(await state()).toMatchObject({ kind: 'available', update: { build: 12, sha256: 'ab'.repeat(32) } });
  });

  it('a phone that runs out of space mid-download is told so, not to check its internet connection, and the partial file goes', async () => {
    MockFile.downloadFileAsync.mockImplementationOnce(async (_url: string, dest: { uri: string }) => {
      mockDisk.set(dest.uri, APK.slice(0, 1000)); // what was written before the disk filled up
      throw new Error('java.io.IOException: write failed: ENOSPC (No space left on device)');
    });
    await installUpdate(update);
    const s = await state();
    expect(s.kind).toBe('error');
    expect(s.message).toMatch(/enough free space/);
    expect(mockDisk.has(apkPath)).toBe(false);
  });

  it('not enough room for it: said before downloading anything', async () => {
    mockSpace.free = APK.length;
    await installUpdate(update);
    expect(MockFile.downloadFileAsync).not.toHaveBeenCalled();
    expect((await state()).message).toMatch(/enough free space/);
  });

  it('a download that doesn’t match GitHub’s SHA-256 is thrown away, not installed', async () => {
    MockFile.downloadFileAsync.mockImplementationOnce(async (_url: string, dest: { uri: string }) => {
      const bad = APK.slice();
      bad[100] ^= 1;
      mockDisk.set(dest.uri, bad);
      return new (require('expo-file-system').File)(dest.uri);
    });
    await installUpdate(update);
    expect((await state()).message).toMatch(/damaged/);
    expect(startActivityAsync).not.toHaveBeenCalled();
    expect(mockDisk.has(apkPath)).toBe(false);
  });

  it('a complete download from before is installed without downloading it again', async () => {
    mockDisk.set(apkPath, APK.slice());
    await installUpdate(update);
    expect(MockFile.downloadFileAsync).not.toHaveBeenCalled();
    expect(startActivityAsync).toHaveBeenCalledWith('android.intent.action.VIEW', expect.objectContaining({ data: `content://provider/${apkPath}` }));
  });
});

describe('checking for updates', () => {
  it('a check that gets no answer gives up after a while instead of "Checking…" for ever', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('Aborted')))),
    );
    const result = checkForUpdate(true);
    await jest.advanceTimersByTimeAsync(25_000);
    expect(await result).toBe('error');
  });

  it('an automatic check that failed (no connection) is tried again in minutes, not hours', async () => {
    const start = Date.now() + 30 * 60 * 60 * 1000;
    jest.spyOn(Date, 'now').mockReturnValue(start);
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    expect(await checkForUpdate()).toBe('error');
    fetchMock.mockResolvedValue(release(13));
    jest.spyOn(Date, 'now').mockReturnValue(start + 20 * 60 * 1000);
    expect(await checkForUpdate()).toBe('available');
  });
});
