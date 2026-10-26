// The app's data modules (src/lib) don't import each other in a circle: Metro warns about every
// require cycle ("Require cycle: src/lib/library.ts -> src/lib/restore.ts -> …"), and a module
// in one can be used before it has finished loading. Imports of types only don't count: they
// are gone from the bundle.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const dir = join(__dirname, '..', 'src', 'lib');

/** The lib modules a module imports at run time. */
function imports(file: string): string[] {
  const src = readFileSync(join(dir, file), 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/^import\s+(type\s+)?([^'"]*?)\s*from\s*'(\.\/|@\/lib\/)([^']+)';/gm)) {
    const [, typeOnly, what, , name] = m;
    if (typeOnly) continue;
    // `import { type A, type B } from` brings in nothing at run time either.
    const names = /^\{([^}]*)\}$/.exec(what.trim())?.[1].split(',').map((x) => x.trim()).filter(Boolean);
    if (names && names.every((n) => n.startsWith('type '))) continue;
    out.push(`${name}.ts`);
  }
  return out;
}

it('no module in src/lib imports itself back through others', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const graph = new Map(files.map((f) => [f, imports(f).filter((g) => files.includes(g))]));
  const cycles: string[] = [];
  const visit = (f: string, path: string[]) => {
    if (path.includes(f)) {
      cycles.push([...path.slice(path.indexOf(f)), f].join(' -> '));
      return;
    }
    for (const g of graph.get(f) ?? []) visit(g, [...path, f]);
  };
  for (const f of files) visit(f, []);
  expect(cycles).toEqual([]);
});
