/// <reference types="jest" />
// The library screen: its search (case, accents and the Turkish I/ı/İ/i don't
// matter, and Android Back closes it), its header on a dark phone, a grid
// that gets more columns as the screen gets wider, what a screen reader says
// for a book, a double tap opening a book once, and a change to one book
// drawing only that book's cell again.

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
let mockShelf: Record<string, unknown>[] = mockBooks;
// Each cell asks for its book's conversion progress as it's drawn: the calls say which cells were drawn.
const mockLive = jest.fn((_id: string) => undefined);
jest.mock('@/lib/library', () => ({
  useLibrary: () => mockShelf,
  useLiveBook: (id: string) => mockLive(id),
  importBooks: jest.fn(),
  reprocessBook: jest.fn(),
  updateBook: jest.fn(),
  coverUri: (b: { id: string }) => (b.id === 'c' ? 'file:///books/c/img/cover.jpg' : undefined),
}));
jest.mock('@/lib/openWith', () => ({ useAddingSharedFile: () => false }));
jest.mock('@/lib/appUpdate', () => ({ CURRENT_BUILD: 0, canSelfUpdate: () => false, checkForUpdate: jest.fn(), useUpdateState: () => ({ kind: 'idle' }) }));
jest.mock('@/lib/shareText', () => ({ shareTextFile: jest.fn() }));
jest.mock('@/ui/dialogs', () => ({ showActions: jest.fn(), showPrompt: jest.fn() }));
// Icons as their names, with their props (whether they're hidden from screen readers).
jest.mock('@expo/vector-icons/Ionicons', () => {
  const { createElement } = require('react');
  const { Text } = require('react-native');
  const Icon = (p: { name: string }) => createElement(Text, p, p.name);
  Icon.glyphMap = {};
  return Icon;
});

const search = () => mockHeader.options!.headerSearchBarOptions!;
const type = (text: string) => act(async () => search().onChangeText?.({ nativeEvent: { text } }));
const shown = (title: string) => screen.queryAllByText(title).length > 0;

afterEach(() => {
  jest.restoreAllMocks();
  mockScheme = 'light';
  mockCanGoBack = false;
  mockShelf = mockBooks;
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
  importBooks.mockResolvedValueOnce({ added: 1, skipped: [], failed: [], unreadable: ['Kuyucaklı Yusuf.epub', 'Notes.txt'], other: [], duplicates: [] });
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

it('files that couldn’t be added for another reason are named too, pointing to the crash log; no space is said apart', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const { importBooks } = jest.requireMock('@/lib/library') as { importBooks: jest.Mock };
  importBooks.mockResolvedValueOnce({ added: 0, skipped: [], failed: ['Big.epub'], unreadable: [], other: ['Broken.epub', 'Odd.fb2'], duplicates: [] });
  await render(<Library />);
  const header = await render(<>{mockHeader.options!.headerRight!()}</>);
  await fireEvent.press(header.getByLabelText('Add books'));
  await act(async () => {});
  expect(alert.mock.calls.map(([title, message]) => [title, message])).toEqual([
    ["Couldn't add some books", "There isn't enough free space on this phone:\n\nBig.epub"],
    ["Couldn't add some books", 'Something went wrong; the crash log has the details (View menu):\n\nBroken.epub\nOdd.fb2'],
  ]);
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

it('a screen reader says each book once: title, author and how far it is; not the generated cover, not the icons', async () => {
  await render(<Library />);
  // The grid: one item per book.
  expect(screen.getByLabelText('İstanbul Hatırası, Ahmet Ümit, New')).toBeTruthy();
  expect(screen.getByLabelText('ILIK RÜZGÂR, New')).toBeTruthy(); // no author: no empty part
  // A generated cover is a picture of the title: drawn, not read out.
  expect(screen.getAllByText('İstanbul Hatırası')).toHaveLength(1);
  expect(screen.getAllByText('İstanbul Hatırası', { includeHiddenElements: true })).toHaveLength(2);
  // The list says the format and size too; its chevrons aren't items of their own.
  await act(() => require('@/lib/collections').setView('list'));
  try {
    expect(screen.getByLabelText('Moby-Dick, Herman Melville, New, EPUB, 1 KB')).toBeTruthy();
    expect(screen.getByLabelText('ILIK RÜZGÂR, New, TXT, 1 KB')).toBeTruthy();
    expect(screen.queryAllByText('chevron-forward')).toHaveLength(0);
    expect(screen.queryAllByText('chevron-forward', { includeHiddenElements: true })).toHaveLength(3);
  } finally {
    await act(() => require('@/lib/collections').setView('grid'));
  }
});

it('a quick double tap opens a book once', async () => {
  const { router } = jest.requireMock('expo-router') as { router: { push: jest.Mock } };
  router.push.mockClear();
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  await render(<Library />);
  await fireEvent.press(screen.getByText('Moby-Dick'));
  await fireEvent.press(screen.getByText('Moby-Dick'));
  expect(router.push).toHaveBeenCalledTimes(1);
  expect(router.push).toHaveBeenCalledWith({ pathname: '/reader/[id]', params: { id: 'c' } });
  // A tap a moment later is a tap of its own.
  now.mockReturnValue(1_600);
  await fireEvent.press(screen.getByText('ILIK RÜZGÂR'));
  expect(router.push).toHaveBeenCalledTimes(2);
  expect(router.push).toHaveBeenLastCalledWith({ pathname: '/reader/[id]', params: { id: 'b' } });
});

it('a change to one book draws only that book’s cell again (the library changes on every page turn)', async () => {
  const view = await render(<Library />);
  mockLive.mockClear();
  // A book's reading place saved: a new list, with a new entry for that book only.
  mockShelf = mockBooks.map((b) => (b.id === 'b' ? { ...b, percent: 0.3 } : b));
  await view.rerender(<Library />);
  expect(mockLive.mock.calls.map(([id]) => id)).toEqual(['b']);

  // Searching: only the changed book's title and author are folded again.
  await type('i');
  const fold = jest.spyOn(require('@/engine/fold') as typeof import('@/engine/fold'), 'fold');
  mockShelf = mockShelf.map((b) => (b.id === 'a' ? { ...b, percent: 0.5 } : b));
  await view.rerender(<Library />);
  expect(fold.mock.calls.filter(([s]) => s.includes('\n'))).toEqual([['İstanbul Hatırası\nAhmet Ümit']]);
});
