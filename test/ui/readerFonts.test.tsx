/// <reference types="jest" />
// Fonts and the reader: the page in the WebView loads its own font, so the
// reader doesn't wait for the phone to load it; and the Display panel's "Aa"
// samples load each font's regular face only, not all of its files.

import { act, render, screen, waitFor } from '@testing-library/react-native';
import * as Font from 'expo-font';
import type { Block, Manifest } from '@/engine/types';
import { FONTS } from '@/lib/fonts';
import { THEMES, setSettings, useSettings } from '@/lib/settings';
import ReaderScreen from '@/app/reader/[id]';
import { DisplayPanel } from '@/reader/DisplayPanel';
import type { FakePage } from './fakePage';

const blocks: Block[] = [{ k: 'p', r: ['It was the best of times, it was the worst of times.'] }];
const manifest: Manifest = { v: 2, format: 'txt', title: 'Two Cities', author: '', totalBlocks: 1, totalChars: 52, chunks: [[0, 0]], toc: [], images: {}, lang: 'en' };
export const manifestForMock = manifest;

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'cities' }), router: { back: jest.fn() } }));
jest.mock('expo-screen-orientation', () => ({ lockAsync: () => Promise.resolve(), OrientationLock: {} }));
jest.mock('@/lib/library', () => ({
  getBook: () => ({ id: 'cities', title: 'Two Cities', author: '', status: 'ready', format: 'txt', position: { b: 0, o: 0 } }),
  loadManifest: () => require('./readerFonts.test').manifestForMock,
  useBookStatus: () => 'ready',
  useLiveBook: () => undefined,
  updateBook: () => {},
  reprocessBook: () => {},
  setBookOpen: () => {},
  sourceFile: () => ({}),
}));
jest.mock('expo-font', () => ({ ...jest.requireActual('expo-font'), loadAsync: jest.fn(() => Promise.resolve()), isLoaded: () => false }));
// A phone where the font files take forever to load.
jest.mock('@/lib/fonts', () => ({
  ...jest.requireActual('@/lib/fonts'),
  isFontLoaded: () => false,
  ensureFont: () => new Promise(() => {}),
}));

const page = () => (globalThis as { __page?: FakePage }).__page!;

beforeAll(() => require('@/lib/storage').testChunks.set('cities/0', JSON.stringify({ b: blocks })));

it("the book is shown without waiting for the phone to load the reading font", async () => {
  setSettings({ font: 'literata', mode: 'page', seenTapZones: true });
  await render(<ReaderScreen />);
  await waitFor(() => expect(page().shown()).toBeTruthy(), { timeout: 5000 });
  expect(screen.queryByText('Loading font…')).toBeNull();
}, 30000);

it("the Display panel's samples load each font's regular face, and nothing else", async () => {
  const load = Font.loadAsync as jest.Mock;
  load.mockClear();
  function Panel() {
    const settings = useSettings();
    return <DisplayPanel visible onClose={() => {}} settings={settings} theme={THEMES.light} onSlide={() => {}} />;
  }
  await render(<Panel />);
  await act(async () => new Promise((r) => setTimeout(r, 10)));
  const loaded = load.mock.calls.flatMap(([map]) => Object.entries(map as Record<string, number>));
  const bundled = FONTS.filter((f) => f.files);
  expect(loaded).toHaveLength(bundled.length);
  expect(loaded.map(([, file]) => file).sort()).toEqual(bundled.map((f) => f.files!.regular).sort());
}, 30000);
