// Loads Yoga, the layout engine React Native itself uses, inside jest. Its
// WebAssembly loader is an ES module that reads import.meta, which jest's
// CommonJS can't parse, so the file is read and evaluated with that one
// expression replaced.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Yoga } from 'yoga-layout/load';

const DIST = join(__dirname, '../../../node_modules/yoga-layout/dist');

let yoga: Promise<Yoga> | undefined;

export function loadYoga(): Promise<Yoga> {
  if (!yoga) {
    const src = readFileSync(join(DIST, 'binaries/yoga-wasm-base64-esm.js'), 'utf8')
      .replace('import.meta.url', '""')
      .replace(/export default loadYoga;?\s*$/, 'return loadYoga;');
    const impl = new Function(src)() as () => Promise<unknown>;
    // Transformed by babel-jest (see transformIgnorePatterns in jest.config.js).
    const wrapAssembly = require(join(DIST, 'src/wrapAssembly.js')).default as (lib: unknown) => Yoga;
    yoga = impl().then(wrapAssembly);
  }
  return yoga;
}

export const enums = () => require(join(DIST, 'src/generated/YGEnums.js')) as typeof import('yoga-layout/load');
