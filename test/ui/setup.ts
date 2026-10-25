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
    safeImageName: jest.requireActual('@/lib/storage').safeImageName,
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
// The reader's WebView: a fake page answering in its place (test/ui/fakePage.ts).
// The latest one is global.__page, for tests to drive.
jest.mock('react-native-webview', () => {
  const { createElement, forwardRef, useEffect, useImperativeHandle, useRef } = require('react');
  const { View } = require('react-native');
  const { FakePage } = require('./fakePage');
  const WebView = forwardRef((props: { onMessage(e: { nativeEvent: { data: string } }): void }, ref: unknown) => {
    const onMessage = useRef(props.onMessage);
    onMessage.current = props.onMessage;
    const page: { current: InstanceType<typeof FakePage> | null } = useRef(null);
    if (!page.current) page.current = new FakePage((m: unknown) => onMessage.current({ nativeEvent: { data: JSON.stringify(m) } }));
    (globalThis as { __page?: unknown }).__page = page.current;
    useImperativeHandle(ref, () => ({
      injectJavaScript(js: string) {
        const json = js.match(/window\.__nec\((.*)\);true;$/s)?.[1];
        if (json) page.current!.receive(JSON.parse(json));
      },
      reload() {
        setTimeout(() => page.current!.load(), 0);
      },
    }));
    useEffect(() => {
      const t = setTimeout(() => page.current!.load(), 0);
      return () => clearTimeout(t);
    }, []);
    return createElement(View, { testID: 'reader-page', style: { flex: 1 } });
  });
  return { WebView, default: WebView };
});
jest.mock('@/reader/web/webFonts', () => ({
  webFont: () => Promise.resolve({ css: '', family: 'serif', medium: false }),
  MONO_FAMILY: 'monospace',
}));
// Font files load in the background on device; treat them as loaded.
jest.mock('@/lib/fonts', () => ({
  ...jest.requireActual('@/lib/fonts'),
  isFontLoaded: () => true,
  ensureFont: () => Promise.resolve(),
  useFontReady: () => true,
}));
