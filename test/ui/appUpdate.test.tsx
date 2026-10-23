/// <reference types="jest" />
// Self-update messages are written for people, and "Not now" hides an offer.

import { renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { executionEnvironment: 'standalone', expoConfig: { extra: { buildNumber: 10, updateRepo: 'me/app' } } },
  ExecutionEnvironment: { StoreClient: 'storeClient' },
}));
jest.mock('expo-intent-launcher', () => ({ startActivityAsync: jest.fn() }));

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
function state() {
  return renderHook(() => useUpdateState()).result.current as { kind: string; message?: string };
}

it('no connection: says so in plain words', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
  expect(await checkForUpdate(true)).toBe('error');
  expect(state()).toEqual({ kind: 'error', message: 'Couldn’t connect. Check the internet connection and try again.' });
});

it('the server refusing (rate limit): not a raw status code', async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
  await checkForUpdate(true);
  expect(state().message).toBe('The update server is busy right now. Try again in a while.');
});

it('"Not now" hides the offer; checking from the menu shows it again', async () => {
  fetchMock.mockResolvedValue(release(11));
  expect(await checkForUpdate(true)).toBe('available');
  snoozeUpdate();
  expect(state().kind).toBe('idle');
  expect(await checkForUpdate(true)).toBe('available');
});
