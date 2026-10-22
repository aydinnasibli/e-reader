// Entry point: figure out what kind of file this is and convert it.

import { ingestEpub } from './epub';
import { ingestFb2 } from './fb2';
import { ingestMobi, isMobi } from './mobi';
import type { IngestContext } from './io';
import { ingestTxt } from './txt';
import type { Manifest } from './types';
import { ZipArchive } from './zip';

export const SUPPORTED_EXTENSIONS = ['epub', 'fb2', 'fb2.zip', 'txt', 'mobi', 'azw3', 'azw', 'prc'];

export function isSupportedName(name: string): boolean {
  const n = name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((e) => n.endsWith('.' + e)) || n.endsWith('.zip');
}

export async function ingestBook(ctx: IngestContext, fileName: string): Promise<Manifest> {
  const head = ctx.src.read(0, Math.min(ctx.src.size, 4));
  const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4;
  const lower = fileName.toLowerCase();

  if (isMobi(ctx.src)) return ingestMobi(ctx);

  if (isZip) {
    const zip = ZipArchive.open(ctx.src);
    if (zip.find('META-INF/container.xml') || [...zip.entries.keys()].some((n) => n.toLowerCase().endsWith('.opf'))) {
      return ingestEpub(ctx, zip);
    }
    const fb2 = [...zip.entries.values()].find((e) => e.name.toLowerCase().endsWith('.fb2'));
    if (fb2) return ingestFb2(ctx, zip, fb2);
    throw new Error('This archive has no EPUB or FB2 book inside');
  }
  if (lower.endsWith('.fb2') || looksLikeFb2(ctx.src.read(0, Math.min(ctx.src.size, 1024)))) return ingestFb2(ctx);
  return ingestTxt(ctx);
}

function looksLikeFb2(head: Uint8Array): boolean {
  let s = '';
  for (let i = 0; i < head.length; i++) if (head[i]) s += String.fromCharCode(head[i]);
  return /<FictionBook/i.test(s);
}

export function titleFromFileName(name: string): string {
  return name.replace(/\.(fb2\.zip|epub|fb2|txt|zip|mobi|azw3|azw|prc)$/i, '').replace(/[_]+/g, ' ').trim() || 'Untitled';
}
