// Adds build-time values to app.json. CI sets BUILD_NUMBER to the GitHub
// Actions run number; the app compares it with the latest GitHub release to
// offer updates.
//
// STORE_BUILD=1 makes a build for Google Play / the App Store: Play doesn't
// allow apps to update themselves or to ask for REQUEST_INSTALL_PACKAGES, so
// the self-updater is switched off and the permission removed.
const BUILD = Number(process.env.BUILD_NUMBER || 0);
const STORE = process.env.STORE_BUILD === '1';
const INSTALL = 'REQUEST_INSTALL_PACKAGES';

module.exports = ({ config }) => ({
  ...config,
  version: BUILD ? `1.0.${BUILD}` : config.version,
  android: {
    ...config.android,
    versionCode: Math.max(1, BUILD),
    ...(STORE
      ? {
          permissions: (config.android?.permissions ?? []).filter((p) => !p.endsWith(INSTALL)),
          blockedPermissions: [...(config.android?.blockedPermissions ?? []), `android.permission.${INSTALL}`],
        }
      : {}),
  },
  ios: { ...config.ios, buildNumber: String(Math.max(1, BUILD)) },
  plugins: [...(config.plugins ?? []), './plugins/withReleaseSigning'],
  extra: { ...config.extra, buildNumber: BUILD, updateRepo: 'aydinnasibli/e-reader', selfUpdate: !STORE },
});
