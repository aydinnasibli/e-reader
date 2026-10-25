// Images extracted from a book are saved under names of safe characters only;
// two different names inside the book never share a file.

import { expect, it, vi } from 'vitest';

vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: {}, FileMode: {} }));
const { safeImageName } = await import('@/lib/storage');

it('plain names stay as they are (images already extracted keep their files)', () => {
  expect(safeImageName('cover.jpg')).toBe('cover.jpg');
  expect(safeImageName('img_01-a.png')).toBe('img_01-a.png');
});

it('names that had to change never collide with each other or with a plain name', () => {
  const names = ['OEBPS/images/a_b.png', 'OEBPS/images/a/b.png', 'OEBPS_images_a_b.png', 'OEBPS/images/a b.png', 'OEBPS/images/ä_b.png'];
  const files = names.map(safeImageName);
  expect(new Set(files).size).toBe(names.length);
  for (const f of files) expect(f).toMatch(/^[A-Za-z0-9._-]+$/);
});

it('hostile or endless names become short, safe file names', () => {
  for (const n of ['../../../library.json', '/etc/passwd', 'x'.repeat(5000) + '.png']) {
    const f = safeImageName(n);
    expect(f).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(f.length).toBeLessThanOrEqual(120);
    expect(f.includes('/')).toBe(false);
  }
  expect(safeImageName('x'.repeat(5000) + '.png')).not.toBe(safeImageName('x'.repeat(5001) + '.png'));
});
