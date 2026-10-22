// Signs Android release builds with signing/release.keystore so every APK
// built by CI can update the previous one (Android requires the same key).
//
// The key and its password are deliberately in this (public) repo: the app
// is shared privately, not published, and this avoids any secret setup.
const { withAppBuildGradle } = require('expo/config-plugins');

const BLOCK = `
        necRelease {
            storeFile rootProject.file('../signing/release.keystore')
            storePassword 'nec-ebook-reader'
            keyAlias 'nec-reader'
            keyPassword 'nec-ebook-reader'
        }`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents;
    if (!gradle.includes('necRelease {')) {
      if (!/signingConfigs\s*\{/.test(gradle)) throw new Error('withReleaseSigning: no signingConfigs block in app/build.gradle');
      gradle = gradle.replace(/signingConfigs\s*\{/, (m) => m + BLOCK);
    }
    const release = /(buildTypes\s*\{[\s\S]*?\brelease\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/;
    if (!release.test(gradle) && !gradle.includes('signingConfig signingConfigs.necRelease')) {
      throw new Error('withReleaseSigning: could not find the release signingConfig');
    }
    gradle = gradle.replace(release, '$1signingConfig signingConfigs.necRelease');
    cfg.modResults.contents = gradle;
    return cfg;
  });
};
