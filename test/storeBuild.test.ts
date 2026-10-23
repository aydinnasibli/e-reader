/// <reference types="node" />
// Store builds (STORE_BUILD=1) leave out what Google Play rejects: the
// self-updater and the REQUEST_INSTALL_PACKAGES permission. Sideloaded CI
// builds keep both.

import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const appJson = require('../app.json').expo;

function resolve(env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    delete require.cache[require.resolve('../app.config.js')];
    return require('../app.config.js')({ config: structuredClone(appJson) });
  } finally {
    process.env = saved;
  }
}

afterEach(() => {
  delete process.env.STORE_BUILD;
});

it('a store build has no install permission and no self-update', () => {
  const c = resolve({ STORE_BUILD: '1', BUILD_NUMBER: '30' });
  expect(c.android.permissions).not.toContain('REQUEST_INSTALL_PACKAGES');
  expect(c.android.blockedPermissions).toContain('android.permission.REQUEST_INSTALL_PACKAGES');
  expect(c.extra.selfUpdate).toBe(false);
  expect(c.android.versionCode).toBe(30);
  // The rest of the Android config is kept.
  expect(c.android.package).toBe('com.nec.ebookreader');
  expect(c.android.intentFilters).toEqual(appJson.android.intentFilters);
});

it('the sideloaded build keeps updating itself', () => {
  const c = resolve({ STORE_BUILD: undefined, BUILD_NUMBER: '30' });
  expect(c.android.permissions).toContain('REQUEST_INSTALL_PACKAGES');
  expect(c.extra.selfUpdate).toBe(true);
});

it('iOS declares no tracking, no collected data and no non-exempt encryption', () => {
  const c = resolve({});
  expect(c.ios.privacyManifests.NSPrivacyTracking).toBe(false);
  expect(c.ios.privacyManifests.NSPrivacyCollectedDataTypes).toEqual([]);
  const reasons = Object.fromEntries(
    c.ios.privacyManifests.NSPrivacyAccessedAPITypes.map((t: { NSPrivacyAccessedAPIType: string; NSPrivacyAccessedAPITypeReasons: string[] }) => [t.NSPrivacyAccessedAPIType, t.NSPrivacyAccessedAPITypeReasons]),
  );
  expect(reasons.NSPrivacyAccessedAPICategoryUserDefaults).toEqual(['CA92.1']);
  expect(reasons.NSPrivacyAccessedAPICategoryFileTimestamp).toEqual(['C617.1']);
  expect(c.ios.infoPlist.ITSAppUsesNonExemptEncryption).toBe(false);
});
