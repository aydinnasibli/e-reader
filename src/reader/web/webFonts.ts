// Reading fonts for the page in the WebView. The bundled font files are
// copied once into the app's documents folder, which the WebView may read
// (see WebReader: allowingReadAccessToURL), and named in @font-face rules.

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

async function makeWebFont(id: string): Promise<WebFont> {
  const def = fontDef(id);
  if (!def.files) return { css: '', family: def.serif ? SYSTEM_SERIF : SYSTEM_SANS, medium: true };
  const dir = new Directory(Paths.document, 'webfonts');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const family = `nec-${id}`;
  let css = '';
  let medium = false;
  for (const [variant, weight, style] of VARIANTS) {
    const moduleId = def.files[variant];
    if (moduleId === undefined) continue;
    const file = new File(dir, `${id}-${variant}.ttf`);
    if (!file.exists) {
      const [asset] = await Asset.loadAsync(moduleId);
      if (!asset.localUri) continue;
      new File(asset.localUri).copySync(file);
    }
    if (weight === 500) medium = true;
    css += `@font-face{font-family:'${family}';src:url('${file.uri}');font-weight:${weight};font-style:${style};}`;
  }
  return { css, family: `'${family}', ${def.serif ? 'serif' : 'sans-serif'}`, medium };
}
