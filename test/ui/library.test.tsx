/// <reference types="jest" />
// The library screen: its search (case, accents and the Turkish I/ı/İ/i don't
// matter, and Android Back closes it), its header on a dark phone, and a grid
// that gets more columns as the screen gets wider.

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Alert, BackHandler, Dimensions, StyleSheet } from 'react-native';
import Library from '@/app/index';

type SearchOptions = {
  ref?: { current: unknown };
  headerIconColor?: string;
  textColor?: string;
  onChangeText?(e: { nativeEvent: { text: string } }): void;
  onOpen?(): void;
  onClose?(): void;
};
type Options = { headerSearchBarOptions?: SearchOptions; headerRight?(): ReactNode };
const mockHeader: { options?: Options } = {};
let mockCanGoBack = false;
let mockScheme: 'light' | 'dark' = 'light';

jest.mock('expo-router', () => ({
  Stack: {
    Screen: ({ options }: { options?: Options }) => {
      if (options?.headerSearchBarOptions) mockHeader.options = options;
      return null;
    },
  },
  router: { push: jest.fn(), back: jest.fn(), canGoBack: () => mockCanGoBack },
}));
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({ __esModule: true, default: () => mockScheme }));
// FlatList lays a list out as FlashList does; the last one drawn is kept to look at.
let mockList: { numColumns?: number } = {};
jest.mock('@shopify/flash-list', () => ({
  FlashList: (props: { numColumns?: number }) => {
    mockList = props;
    return require('react').createElement(require('react-native').FlatList, props);
  },
}));
const mockBooks = [
  { id: 'a', title: 'İstanbul Hatırası', author: 'Ahmet Ümit', fileName: 'a.epub', format: 'epub', size: 1000, addedAt: 1, openedAt: 3, status: 'ready', progress: 1 },
  { id: 'b', title: 'ILIK RÜZGÂR', author: '', fileName: 'b.txt', format: 'txt', size: 1000, addedAt: 2, openedAt: 2, status: 'ready', progress: 1 },
  { id: 'c', title: 'Moby-Dick', author: 'Herman Melville', fileName: 'c.epub', format: 'epub', size: 1000, addedAt: 3, openedAt: 1, status: 'ready', progress: 1 },
];
jest.mock('@/lib/library', () => ({
  useLibrary: () => mockBooks,
  useLiveBook: () => undefined,
  importBooks: jest.fn(),
  reprocessBook: jest.fn(),
  updateBook: jest.fn(),
  coverUri: (b: { id: string }) => (b.id === 'c' ? 'file:///books/c/img/cover.jpg' : undefined),
}));
jest.mock('@/lib/openWith', () => ({ useAddingSharedFile: () => false }));
jest.mock('@/lib/appUpdate', () => ({ CURRENT_BUILD: 0, canSelfUpdate: () => false, checkForUpdate: jest.fn(), useUpdateState: () => ({ kind: 'idle' }) }));
jest.mock('@/lib/shareText', () => ({ shareTextFile: jest.fn() }));
jest.mock('@/ui/dialogs', () => ({ showActions: jest.fn(), showPrompt: jest.fn() }));

const search = () => mockHeader.options!.headerSearchBarOptions!;
const type = (text: string) => act(async () => search().onChangeText?.({ nativeEvent: { text } }));
const shown = (title: string) => screen.queryAllByText(title).length > 0;

afterEach(() => {
  jest.restoreAllMocks();
  mockScheme = 'light';
  mockCanGoBack = false;
});

it('search ignores case, accents and the Turkish I/ı/İ/i, on a phone set to English', async () => {
  // A phone whose language is English: lower-casing without a locale uses it.
  const lower = String.prototype.toLocaleLowerCase;
  jest.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (this: string, locales?: Intl.LocalesArgument) {
    return lower.call(this, locales ?? 'en-US');
  });
  await render(<Library />);
  await type('moby');
  expect(shown('Moby-Dick')).toBe(true);
  expect(shown('İstanbul Hatırası')).toBe(false);
  await type('istanbul');
  expect(shown('İstanbul Hatırası')).toBe(true);
  expect(shown('Moby-Dick')).toBe(false);
  await type('ılık');
  expect(shown('ILIK RÜZGÂR')).toBe(true);
  await type('ruzgar');
  expect(shown('ILIK RÜZGÂR')).toBe(true);
  await type('ahmet umit'); // the author
  expect(shown('İstanbul Hatırası')).toBe(true);
  await type('HATIRASI');
  expect(shown('İstanbul Hatırası')).toBe(true);
});

it('Android Back closes an open search first, and is left to the screen on top of the library', async () => {
  const remove = jest.fn();
  const add = jest.spyOn(BackHandler, 'addEventListener').mockImplementation(() => ({ remove }));
  await render(<Library />);
  const cancelSearch = jest.fn();
  search().ref!.current = { cancelSearch };
  await act(async () => search().onOpen?.());
  await type('moby');
  expect(shown('İstanbul Hatırası')).toBe(false);
  const back = add.mock.calls.at(-1)![1] as () => boolean;

  // A book opened from the results is on top: Back is the reader's.
  mockCanGoBack = true;
  expect(back()).toBe(false);
  expect(cancelSearch).not.toHaveBeenCalled();

  mockCanGoBack = false;
  let handled = false;
  await act(async () => {
    handled = back();
  });
  expect(handled).toBe(true);
  expect(cancelSearch).toHaveBeenCalled();
  expect(shown('İstanbul Hatırası')).toBe(true); // the whole shelf again
  expect(remove).toHaveBeenCalled(); // and Back goes back to leaving the app
});

it('closing the search (Android) shows the whole shelf again', async () => {
  await render(<Library />);
  await act(async () => search().onOpen?.());
  await type('moby');
  expect(shown('ILIK RÜZGÂR')).toBe(false);
  await act(async () => search().onClose?.());
  expect(shown('ILIK RÜZGÂR')).toBe(true);
});

it('the search icon and text are drawn in the theme’s colours, so they show on a dark header', async () => {
  mockScheme = 'dark';
  await render(<Library />);
  // The dark theme's text colour (src/ui/theme.ts); Android's default is black.
  expect(search().headerIconColor).toBe('#F2F2F4');
  expect(search().textColor).toBe('#F2F2F4');
});

it('files the picker handed over but the app couldn’t read (a cloud app) are named, with what to do', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const { importBooks } = jest.requireMock('@/lib/library') as { importBooks: jest.Mock };
  importBooks.mockResolvedValueOnce({ added: 1, skipped: [], failed: [], unreadable: ['Kuyucaklı Yusuf.epub', 'Notes.txt'], duplicates: [] });
  await render(<Library />);
  const header = await render(<>{mockHeader.options!.headerRight!()}</>);
  await fireEvent.press(header.getByLabelText('Add books'));
  await act(async () => {});
  expect(alert).toHaveBeenCalledTimes(1);
  const [title, message] = alert.mock.calls[0];
  expect(title).toBe("Couldn't read some files");
  expect(message).toContain('Save them to the phone (Files or Downloads) and add them from there');
  expect(message).toContain('Kuyucaklı Yusuf.epub\nNotes.txt');
});

it('the header’s buttons are 44-point squares', async () => {
  await render(<Library />);
  const header = await render(<>{mockHeader.options!.headerRight!()}</>);
  for (const label of ['Highlights and notes', 'Reading stats', 'View options', 'Add books']) {
    const st = StyleSheet.flatten(header.getByLabelText(label).props.style);
    expect([label, st.width, st.height]).toEqual([label, 44, 44]);
  }
});

it('a cover is tied to its book, so a recycled cell never shows another book’s cover while loading', async () => {
  await render(<Library />);
  const images: { props: Record<string, unknown> }[] = [];
  (function find(n: unknown) {
    if (Array.isArray(n)) return n.forEach(find);
    const h = n as { type?: string; props?: Record<string, unknown>; children?: unknown[] } | null;
    if (!h || typeof h !== 'object') return;
    if (h.type === 'ViewManagerAdapter_ExpoImage') images.push(h as { props: Record<string, unknown> });
    (h.children ?? []).forEach(find);
  })(screen.toJSON());
  expect(images.length).toBeGreaterThan(0);
  expect(images.every((i) => i.props.recyclingKey === 'c')).toBe(true);
});

it('the grid gets more columns as the screen gets wider; a phone keeps three', async () => {
  const columns: number[] = [];
  for (const [width, height] of [
    [360, 640],
    [390, 844],
    [844, 390],
    [1024, 1366],
    [1366, 1024],
  ]) {
    const win = { width, height, scale: 3, fontScale: 1 };
    Dimensions.set({ window: win, screen: win });
    const view = await render(<Library />);
    columns.push(mockList.numColumns ?? 1);
    await view.unmount();
  }
  expect(columns).toEqual([3, 3, 5, 6, 8]);
});
