// Builds the stress benchmark and runs it under Node and/or Hermes.
//
//   node bench/run.mjs node            # Node only
//   node bench/run.mjs hermes          # Hermes only (needs HERMES=/path/to/hermes)
//   BENCH_ONLY=txt,epub node bench/run.mjs hermes
//
// Hermes is the JavaScript engine React Native runs on phones, so its numbers
// are the ones that matter. The `hermes` CLI binary comes from the
// `hermes-engine-cli` npm package; esbuild and @babel/core must be resolvable.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'bench', '.out');
mkdirSync(out, { recursive: true });

const esbuild = require(process.env.ESBUILD ?? 'esbuild');
const babel = require('@babel/core');
const { deflateSync } = require('fflate');

const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['node', 'hermes'];

// The giant EPUB chapter is generated and compressed here once, then embedded,
// because Hermes has no file system access.
const bundle = await esbuild.build({
  entryPoints: [join(root, 'bench', 'stress.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'Bench',
  target: 'es2019',
});
const code = bundle.outputFiles[0].text;

const tmp = await esbuild.build({ entryPoints: [join(root, 'bench', 'stress.ts')], bundle: true, write: false, format: 'cjs', platform: 'node' });
const m = { exports: {} };
new Function('module', 'exports', 'require', tmp.outputFiles[0].text)(m, m.exports, require);
const html = m.exports.giantChapterHtml(40);
const deflated = deflateSync(html, { level: 6 });
const fixture = `var BENCH_FIXTURE = { chapterB64: ${JSON.stringify(Buffer.from(deflated).toString('base64'))}, chapterSize: ${html.length} };\n`;
const only = `var BENCH_ONLY = ${JSON.stringify(process.env.BENCH_ONLY ?? '')};\n`;
const program = fixture + only + code + '\nBench.main();\n';

if (targets.includes('node')) {
  const file = join(out, 'bench-node.js');
  writeFileSync(file, program);
  execFileSync(process.execPath, ['--max-old-space-size=4096', file], { stdio: 'inherit' });
}

if (targets.includes('hermes')) {
  // Same transforms React Native applies for Hermes: classes etc. are compiled down.
  const lowered = babel.transformSync(code, {
    babelrc: false,
    configFile: false,
    compact: true,
    plugins: ['@babel/plugin-transform-classes', '@babel/plugin-transform-block-scoping', '@babel/plugin-transform-async-to-generator'],
  }).code;
  const file = join(out, 'bench-hermes.js');
  writeFileSync(file, fixture + only + lowered + '\nBench.main();\n');
  const hermes = process.env.HERMES;
  if (!hermes) throw new Error('Set HERMES to the hermes CLI binary');
  execFileSync(hermes, ['-O', '-gc-max-heap=3G', file], { stdio: 'inherit', maxBuffer: 1 << 26 });
}
