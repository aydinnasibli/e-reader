// EPUBs often link files with the wrong case ("Images/Cover.JPG" for
// "images/cover.jpg"): entries are found anyway, the same one every time.

import { strToU8, zipSync } from 'fflate';
import { expect, it } from 'vitest';
import { ZipArchive } from '../src/engine/zip';
import { MemorySource } from './helpers';

it('finds entries by exact path first, then ignoring case', () => {
  const zip = ZipArchive.open(
    new MemorySource(zipSync({ 'OEBPS/images/cover.jpg': strToU8('a'), 'OEBPS/Text/ch1.xhtml': strToU8('b'), 'OEBPS/text/CH1.xhtml': strToU8('c') })),
  );
  expect(zip.find('OEBPS/images/cover.jpg')?.name).toBe('OEBPS/images/cover.jpg');
  expect(zip.find('oebps/Images/Cover.JPG')?.name).toBe('OEBPS/images/cover.jpg');
  // Exact matches win; among case-only twins, the first in the archive.
  expect(zip.find('OEBPS/text/CH1.xhtml')?.name).toBe('OEBPS/text/CH1.xhtml');
  expect(zip.find('oebps/text/ch1.xhtml')?.name).toBe('OEBPS/Text/ch1.xhtml');
  expect(zip.find('OEBPS/missing.png')).toBeUndefined();
});
