export const Platform = { OS: globalThis.__OS || 'android', select: (o) => (o[globalThis.__OS || 'android'] ?? o.default) };
export const Appearance = { getColorScheme: () => 'light' };
export const PixelRatio = { getFontScale: () => 1 };
export const useColorScheme = () => 'light';
export const StyleSheet = { create: (s) => s };
