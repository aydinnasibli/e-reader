// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'bench/.out/*'],
  },
  {
    // These rules exist for the React Compiler, which this app has turned off
    // (app.json). The reader deliberately keeps gesture handlers and layout
    // caches in refs, which is the normal pattern without the compiler.
    rules: {
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },
  {
    files: ['bench/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: { globals: { Buffer: 'readonly', process: 'readonly' } },
  },
]);
