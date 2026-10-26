// Reading fonts. Two system fonts plus bundled Google Fonts. A bundled font
// is loaded the first time it's used or previewed, so unused ones cost nothing
// at startup.

import * as Font from 'expo-font';
import { Platform, type TextStyle } from 'react-native';

export type Weight = 'regular' | 'medium';

interface Variants {
  regular: number;
  italic: number;
  bold: number;
  boldItalic: number;
  medium?: number;
  mediumItalic?: number;
}

export interface FontDef {
  id: string;
  label: string;
  /** Shown under the name, e.g. missing Cyrillic. */
  note?: string;
  serif: boolean;
  files?: Variants;
}

export const FONTS: FontDef[] = [
  { id: 'serif', label: Platform.OS === 'ios' ? 'Georgia' : 'Noto Serif', serif: true },
  { id: 'sans', label: Platform.OS === 'ios' ? 'San Francisco' : 'Roboto', serif: false },
  {
    id: 'literata',
    label: 'Literata',
    serif: true,
    files: {
      regular: require('@expo-google-fonts/literata/400Regular/Literata_400Regular.ttf'),
      italic: require('@expo-google-fonts/literata/400Regular_Italic/Literata_400Regular_Italic.ttf'),
      bold: require('@expo-google-fonts/literata/700Bold/Literata_700Bold.ttf'),
      boldItalic: require('@expo-google-fonts/literata/700Bold_Italic/Literata_700Bold_Italic.ttf'),
      medium: require('@expo-google-fonts/literata/500Medium/Literata_500Medium.ttf'),
      mediumItalic: require('@expo-google-fonts/literata/500Medium_Italic/Literata_500Medium_Italic.ttf'),
    },
  },
  {
    id: 'merriweather',
    label: 'Merriweather',
    serif: true,
    files: {
      regular: require('@expo-google-fonts/merriweather/400Regular/Merriweather_400Regular.ttf'),
      italic: require('@expo-google-fonts/merriweather/400Regular_Italic/Merriweather_400Regular_Italic.ttf'),
      bold: require('@expo-google-fonts/merriweather/700Bold/Merriweather_700Bold.ttf'),
      boldItalic: require('@expo-google-fonts/merriweather/700Bold_Italic/Merriweather_700Bold_Italic.ttf'),
      medium: require('@expo-google-fonts/merriweather/500Medium/Merriweather_500Medium.ttf'),
      mediumItalic: require('@expo-google-fonts/merriweather/500Medium_Italic/Merriweather_500Medium_Italic.ttf'),
    },
  },
  {
    id: 'lora',
    label: 'Lora',
    serif: true,
    files: {
      regular: require('@expo-google-fonts/lora/400Regular/Lora_400Regular.ttf'),
      italic: require('@expo-google-fonts/lora/400Regular_Italic/Lora_400Regular_Italic.ttf'),
      bold: require('@expo-google-fonts/lora/700Bold/Lora_700Bold.ttf'),
      boldItalic: require('@expo-google-fonts/lora/700Bold_Italic/Lora_700Bold_Italic.ttf'),
      medium: require('@expo-google-fonts/lora/500Medium/Lora_500Medium.ttf'),
      mediumItalic: require('@expo-google-fonts/lora/500Medium_Italic/Lora_500Medium_Italic.ttf'),
    },
  },
  {
    id: 'ptserif',
    label: 'PT Serif',
    serif: true,
    files: {
      regular: require('@expo-google-fonts/pt-serif/400Regular/PTSerif_400Regular.ttf'),
      italic: require('@expo-google-fonts/pt-serif/400Regular_Italic/PTSerif_400Regular_Italic.ttf'),
      bold: require('@expo-google-fonts/pt-serif/700Bold/PTSerif_700Bold.ttf'),
      boldItalic: require('@expo-google-fonts/pt-serif/700Bold_Italic/PTSerif_700Bold_Italic.ttf'),
    },
  },
  {
    id: 'garamond',
    label: 'EB Garamond',
    serif: true,
    files: {
      regular: require('@expo-google-fonts/eb-garamond/400Regular/EBGaramond_400Regular.ttf'),
      italic: require('@expo-google-fonts/eb-garamond/400Regular_Italic/EBGaramond_400Regular_Italic.ttf'),
      bold: require('@expo-google-fonts/eb-garamond/700Bold/EBGaramond_700Bold.ttf'),
      boldItalic: require('@expo-google-fonts/eb-garamond/700Bold_Italic/EBGaramond_700Bold_Italic.ttf'),
      medium: require('@expo-google-fonts/eb-garamond/500Medium/EBGaramond_500Medium.ttf'),
      mediumItalic: require('@expo-google-fonts/eb-garamond/500Medium_Italic/EBGaramond_500Medium_Italic.ttf'),
    },
  },
  {
    id: 'opensans',
    label: 'Open Sans',
    serif: false,
    files: {
      regular: require('@expo-google-fonts/open-sans/400Regular/OpenSans_400Regular.ttf'),
      italic: require('@expo-google-fonts/open-sans/400Regular_Italic/OpenSans_400Regular_Italic.ttf'),
      bold: require('@expo-google-fonts/open-sans/700Bold/OpenSans_700Bold.ttf'),
      boldItalic: require('@expo-google-fonts/open-sans/700Bold_Italic/OpenSans_700Bold_Italic.ttf'),
      medium: require('@expo-google-fonts/open-sans/500Medium/OpenSans_500Medium.ttf'),
      mediumItalic: require('@expo-google-fonts/open-sans/500Medium_Italic/OpenSans_500Medium_Italic.ttf'),
    },
  },
  {
    // The "Next" edition: the first one has no capital İ, so Turkish words
    // were drawn with a letter from another font. Same id, so a saved choice
    // of the old one carries over.
    id: 'atkinson',
    label: 'Atkinson Hyperlegible Next',
    note: 'Latin only',
    serif: false,
    files: {
      regular: require('@expo-google-fonts/atkinson-hyperlegible-next/400Regular/AtkinsonHyperlegibleNext_400Regular.ttf'),
      italic: require('@expo-google-fonts/atkinson-hyperlegible-next/400Regular_Italic/AtkinsonHyperlegibleNext_400Regular_Italic.ttf'),
      bold: require('@expo-google-fonts/atkinson-hyperlegible-next/700Bold/AtkinsonHyperlegibleNext_700Bold.ttf'),
      boldItalic: require('@expo-google-fonts/atkinson-hyperlegible-next/700Bold_Italic/AtkinsonHyperlegibleNext_700Bold_Italic.ttf'),
      medium: require('@expo-google-fonts/atkinson-hyperlegible-next/500Medium/AtkinsonHyperlegibleNext_500Medium.ttf'),
      mediumItalic: require('@expo-google-fonts/atkinson-hyperlegible-next/500Medium_Italic/AtkinsonHyperlegibleNext_500Medium_Italic.ttf'),
    },
  },
];

const SYSTEM_SERIF = Platform.select({ ios: 'Georgia', android: 'serif', default: 'serif' });

export function fontDef(id: string): FontDef {
  return FONTS.find((f) => f.id === id) ?? FONTS[0];
}

const familyName = (id: string, v: keyof Variants) => `${id}-${v}`;

const loaded = new Set<string>(['serif', 'sans']);
const loading = new Map<string, Promise<void>>();

/** Load every variant of a bundled font. Resolves immediately for system fonts. */
export function ensureFont(id: string): Promise<void> {
  if (loaded.has(id)) return Promise.resolve();
  let p = loading.get(id);
  if (!p) {
    const def = fontDef(id);
    const map: Record<string, number> = {};
    for (const [v, src] of Object.entries(def.files ?? {})) map[familyName(id, v as keyof Variants)] = src;
    p = Font.loadAsync(map).then(
      () => {
        loaded.add(id);
      },
      (e) => {
        loading.delete(id);
        throw e;
      },
    );
    loading.set(id, p);
  }
  return p;
}

export function isFontLoaded(id: string) {
  return loaded.has(id);
}

/**
 * The text style for a font with the given emphasis. Bundled fonts use a
 * separate family per variant (no synthetic bold/italic, which renders
 * differently on iOS and Android); system fonts use weight/style.
 */
export function fontFace(id: string, weight: Weight, bold: boolean, italic: boolean): TextStyle {
  const def = fontDef(id);
  if (!def.files || !loaded.has(id)) {
    // System font (or a bundled one that hasn't loaded yet: nearest system face).
    return {
      fontFamily: def.serif ? SYSTEM_SERIF : undefined,
      fontWeight: bold ? '700' : weight === 'medium' ? '500' : '400',
      fontStyle: italic ? 'italic' : 'normal',
    };
  }
  let v: keyof Variants;
  if (bold) v = italic ? 'boldItalic' : 'bold';
  else if (weight === 'medium' && def.files.medium) v = italic ? 'mediumItalic' : 'medium';
  else v = italic ? 'italic' : 'regular';
  return { fontFamily: familyName(id, v), fontWeight: 'normal', fontStyle: 'normal' };
}
