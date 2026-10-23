// Adds build-time values to app.json. CI sets BUILD_NUMBER to the GitHub
// Actions run number; the app compares it with the latest GitHub release to
// offer updates.
const BUILD = Number(process.env.BUILD_NUMBER || 0);

module.exports = ({ config }) => ({
  ...config,
  version: BUILD ? `1.0.${BUILD}` : config.version,
  android: { ...config.android, versionCode: Math.max(1, BUILD) },
  ios: { ...config.ios, buildNumber: String(Math.max(1, BUILD)) },
  plugins: [...(config.plugins ?? []), './plugins/withReleaseSigning'],
  extra: { ...config.extra, buildNumber: BUILD, updateRepo: 'aydinnasibli/e-reader' },
});
