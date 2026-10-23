// Search goes on past a damaged chunk file instead of stopping (with the
// search sheet spinning forever).

import { expect, it, vi } from 'vitest';
import type { SearchProgress } from '../src/reader/search';

const files: Record<string, string> = {
  'b/0': JSON.stringify({ b: [{ k: 'p', r: ['The whale surfaced.'] }] }),
  'b/1': '{"b": [{"k": "p", "r": ["trunc', // cut off mid-write
  'b/2': 'null',
  'b/3': JSON.stringify({ b: [{ k: 'p', r: ['Another whale.'] }] }),
};
vi.mock('@/lib/storage', () => ({
  chunkFile: (id: string, i: number) => ({ text: () => (files[`${id}/${i}`] !== undefined ? Promise.resolve(files[`${id}/${i}`]) : Promise.reject(new Error('missing'))) }),
}));

it('finds hits after a damaged chunk and finishes', async () => {
  const { searchBook } = await import('../src/reader/search');
  const book = { entry: { id: 'b' }, chunkCount: 5, chunkStart: (i: number) => i * 10 } as never;
  const done = await new Promise<SearchProgress>((resolve) => searchBook(book, 'whale', (p) => p.finished && resolve(p)));
  expect(done.hits.map((h) => h.b)).toEqual([0, 30]);
});
