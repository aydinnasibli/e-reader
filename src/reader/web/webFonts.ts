// Reading fonts for the page in the WebView. The bundled font files are
// copied into the app's documents folder, which the WebView may read (see
// WebReader: allowingReadAccessToURL), and named in @font-face rules. A copy
// is named after its file's contents, so a font file changed by an update is
// copied again (and the old copy deleted).

import { Asset } from 'expo-asset';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { fontDef } from '@/lib/fonts';

/** The phone's own fonts, as the native text views name them. */
const SYSTEM_SERIF = Platform.select({ ios: 'Georgia, serif', default: "'Noto Serif', serif" });
const SYSTEM_SANS = "-apple-system, system-ui, Roboto, 'Helvetica Neue', sans-serif";
export const MONO_FAMILY = Platform.select({ ios: 'Menlo, monospace', default: 'monospace' });

const VARIANTS = [
  ['regular', 400, 'normal'],
  ['italic', 400, 'italic'],
  ['bold', 700, 'normal'],
  ['boldItalic', 700, 'italic'],
  ['medium', 500, 'normal'],
  ['mediumItalic', 500, 'italic'],
] as const;

export interface WebFont {
  /** @font-face rules (empty for the phone's own fonts). */
  css: string;
  /** The same rules one face at a time, so the page is given only the faces its text uses. */
  faces?: { weight: number; css: string }[];
  family: string;
  /** The font has a medium weight (the "medium" text weight uses it). */
  medium: boolean;
}

const made = new Map<string, Promise<WebFont>>();

/** The CSS that makes reading font `id` available in the page. */
export function webFont(id: string): Promise<WebFont> {
  let p = made.get(id);
  if (!p) {
    p = makeWebFont(id);
    made.set(id, p);
    // A failure (a copy that couldn't be made) is tried again next time.
    p.catch(() => made.delete(id));
  }
  return p;
}

/** The copy of a font file: its font, its variant and what's in it (the asset's hash) in the name. */
export function copyName(id: string, variant: string, hash: string | null | undefined): string {
  return hash ? `${id}-${variant}-${hash}.ttf` : `${id}-${variant}.ttf`;
}

async function makeWebFont(id: string): Promise<WebFont> {
  const def = fontDef(id);
  if (!def.files) return { css: '', family: def.serif ? SYSTEM_SERIF : SYSTEM_SANS, medium: true };
  const dir = new Directory(Paths.document, 'webfonts');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const family = `nec-${id}`;
  const faces: { weight: number; css: string }[] = [];
  const names = new Set<string>();
  let medium = false;
  for (const [variant, weight, style] of VARIANTS) {
    const moduleId = def.files[variant];
    if (moduleId === undefined) continue;
    const asset = Asset.fromModule(moduleId);
    const name = copyName(id, variant, asset.hash);
    const file = new File(dir, name);
    if (!file.exists) {
      await asset.downloadAsync();
      if (!asset.localUri) continue;
      new File(asset.localUri).copySync(file);
    }
    names.add(name);
    if (weight === 500) medium = true;
    faces.push({ weight, css: `@font-face{font-family:'${family}';src:url('${file.uri}');font-weight:${weight};font-style:${style};}` });
  }
  removeStale(dir, id, names);
  return { css: faces.map((f) => f.css).join(''), faces, family: `'${family}', ${def.serif ? 'serif' : 'sans-serif'}`, medium };
}

/** Copies of font `id` made from other files (an older version of the font): no longer used. */
function removeStale(dir: Directory, id: string, keep: Set<string>) {
  try {
    for (const f of dir.list()) {
      if (f instanceof File && f.name.startsWith(`${id}-`) && !keep.has(f.name)) f.delete();
    }
  } catch {
    // Left for next time.
  }
}
