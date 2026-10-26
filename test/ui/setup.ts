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
    imageFile: (id: string, name: string) => ({ exists: false, uri: `file:///doc/books/${id}/img/${name}` }),
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
jest.mock('expo-navigation-bar', () => ({
  NavigationBar: () => null,
  setStyle: () => {},
  setVisibilityAsync: () => Promise.resolve(),
  getVisibilityAsync: () => Promise.resolve('visible'),
  useVisibility: () => 'visible',
  addVisibilityListener: () => ({ remove: () => {} }),
}));
// Icons load their font asynchronously; draw them as their name instead.
jest.mock('@expo/vector-icons/Ionicons', () => {
  const { createElement } = require('react');
  const { Text } = require('react-native');
  const Icon = (p: { name: string }) => createElement(Text, null, p.name);
  Icon.glyphMap = {};
  return Icon;
});
// The reader's WebView: a fake page answering in its place (test/ui/fakePage.ts).
// The latest one is global.__page, for tests to drive; global.__webView holds
// the WebView's props (to play the system stopping its process),
// global.__webViews counts the WebViews made, and with global.__pageSilent the
// page never says it's ready (a page that doesn't load).
jest.mock('react-native-webview', () => {
  const { createElement, forwardRef, useEffect, useImperativeHandle, useRef } = require('react');
  const { View } = require('react-native');
  const { FakePage } = require('./fakePage');
  const g = globalThis as { __page?: unknown; __webView?: unknown; __webViews?: number; __pageSilent?: boolean };
  const WebView = forwardRef(function WebView(props: { onMessage(e: { nativeEvent: { data: string } }): void }, ref: unknown) {
    const onMessage = useRef(props.onMessage);
    onMessage.current = props.onMessage;
    const page: { current: InstanceType<typeof FakePage> | null } = useRef(null);
    if (!page.current) {
      page.current = new FakePage((m: unknown) => onMessage.current({ nativeEvent: { data: JSON.stringify(m) } }));
      g.__webViews = (g.__webViews ?? 0) + 1;
    }
    g.__page = page.current;
    g.__webView = props;
    useImperativeHandle(ref, () => ({
      injectJavaScript(js: string) {
        const json = js.match(/window\.__nec\((.*)\);true;$/s)?.[1];
        if (json) page.current!.receive(JSON.parse(json));
      },
      reload() {
        setTimeout(() => !g.__pageSilent && page.current!.load(), 0);
      },
    }));
    useEffect(() => {
      const t = setTimeout(() => !g.__pageSilent && page.current!.load(), 0);
      return () => clearTimeout(t);
    }, []);
    return createElement(View, { testID: 'reader-page', style: { flex: 1 } });
  });
  return { WebView, default: WebView };
});
// The phone's bars (status bar, navigation bar, home indicator) are native screen options.
jest.mock('@/reader/SystemBars', () => ({ SystemBars: () => null }));
jest.mock('@/reader/web/webFonts', () => ({
  webFont: () => Promise.resolve({ css: '', family: 'serif', medium: false }),
  MONO_FAMILY: 'monospace',
}));
// Font files load in the background on device; treat them as loaded.
jest.mock('@/lib/fonts', () => ({
  ...jest.requireActual('@/lib/fonts'),
  isFontLoaded: () => true,
  ensureFont: () => Promise.resolve(),
}));
