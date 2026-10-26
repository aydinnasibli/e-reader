// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'bench/.out/*'],
  },
  {
    // These rules came with the React Compiler, which this app has turned off
    // (app.json). They are also the Rules of React (no reading refs while
    // drawing, no state set straight from an effect), so the app's code keeps
    // them, below. The reader deliberately keeps gesture handlers and layout
    // caches in refs, the normal pattern without the compiler; tests and
    // scripts are left out too.
    rules: {
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/reader/**', 'src/app/reader/**'],
    rules: {
      'react-hooks/refs': 'error',
      'react-hooks/set-state-in-effect': 'error',
      'react-hooks/immutability': 'error',
      'react-hooks/preserve-manual-memoization': 'error',
    },
  },
  {
    files: ['bench/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: { globals: { Buffer: 'readonly', process: 'readonly' } },
  },
]);
