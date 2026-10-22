// Component tests (test/ui/*.test.tsx): real screens and panels rendered with
// React Native's test renderer, driven by taps and slider drags. Engine and
// logic tests run in vitest (test/*.test.ts). `npm test` runs both.
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/test/ui/**/*.test.tsx'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  setupFiles: ['<rootDir>/test/ui/setup.ts'],
};
