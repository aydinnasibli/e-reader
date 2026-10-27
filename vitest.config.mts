import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['test/**/*.test.ts'],
    // The engine tests convert whole books (450 damaged ones in corrupt.test.ts): on a busy
    // machine (CI, or jest and tsc running too) one can take several seconds, past the default
    // 5 s. A limit is there to catch a hang; speed is checked by counting work, not by the clock.
    testTimeout: 30000,
    // Half the cores, as jest: with every core busy the heavy files starve the rest.
    maxWorkers: '50%',
  },
});
