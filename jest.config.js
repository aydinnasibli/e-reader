// Component tests (test/ui/*.test.tsx): real screens and panels rendered with
// React Native's test renderer, driven by taps and slider drags. Engine and
// logic tests run in vitest (test/*.test.ts). `npm test` runs both.
const preset = require('jest-expo/jest-preset');

module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/test/ui/**/*.test.tsx'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  setupFiles: ['<rootDir>/test/ui/setup.ts'],
  // The first test in a file also pays for loading the screen's modules, which
  // takes several seconds on a busy machine (CI): the default 5 s is too tight.
  testTimeout: 15000,
  // Half the cores, not all but one: with a full set of workers (and vitest,
  // tsc or a second checkout running too) the machine is so busy that a
  // screen's first test can run past that limit.
  maxWorkers: '50%',
  // yoga-layout (the layout tests in test/ui/layout) ships ES modules.
  transformIgnorePatterns: preset.transformIgnorePatterns.map((p) => p.replace('|standard-navigation))', '|standard-navigation|yoga-layout))')),
};
