/// <reference types="jest" />
// Device-only modules replaced for component tests. Storage keeps nothing, so
// each test file starts with empty settings and annotations.

jest.mock('expo-file-system', () => ({
  File: class {
    exists = false;
  },
  Directory: class {},
  Paths: { document: 'doc' },
}));
jest.mock('@/lib/storage', () => {
  // Converted book chunks, put here by tests: "<book id>/<chunk index>" -> JSON.
  const chunks = new Map<string, string>();
  return {
    readJson: () => null,
    writeJson: () => {},
    saveJson: () => true,
    chunkFile: (id: string, i: number) => ({
      text: () => {
        const t = chunks.get(`${id}/${i}`);
        return t ? Promise.resolve(t) : Promise.reject(new Error('missing chunk'));
      },
    }),
    imageFile: () => ({ exists: false, uri: '' }),
    testChunks: chunks,
  };
});
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-haptics', () => ({
  selectionAsync: () => Promise.resolve(),
  impactAsync: () => Promise.resolve(),
  notificationAsync: () => Promise.resolve(),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success' },
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: () => Promise.resolve(true) }));
jest.mock('expo-keep-awake', () => ({ activateKeepAwakeAsync: jest.fn(() => Promise.resolve()), deactivateKeepAwake: jest.fn(() => Promise.resolve()) }));
jest.mock('expo-battery', () => ({ getBatteryLevelAsync: () => Promise.resolve(0.82) }));
jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }));
// Icons load their font asynchronously; draw them as their name instead.
jest.mock('@expo/vector-icons/Ionicons', () => {
  const { createElement } = require('react');
  const { Text } = require('react-native');
  const Icon = (p: { name: string }) => createElement(Text, null, p.name);
  Icon.glyphMap = {};
  return Icon;
});
// Font files load in the background on device; treat them as loaded.
jest.mock('@/lib/fonts', () => ({
  ...jest.requireActual('@/lib/fonts'),
  isFontLoaded: () => true,
  ensureFont: () => Promise.resolve(),
  useFontReady: () => true,
}));
