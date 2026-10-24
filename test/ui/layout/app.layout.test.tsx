/// <reference types="jest" />
// The library, book details, highlights & notes, menus and prompts, reading
// stats, the dictionary/translation sheet and the selection menu, laid out on
// phones of several sizes, in landscape and on a tablet, at larger text sizes
// and with the keyboard open (see check.ts).

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { View } from 'react-native';
import Library from '@/app/index';
import BookDetails from '@/app/book/[id]';
import NotesScreen from '@/app/notes';
import { addHighlight } from '@/lib/annotations';
import { THEMES } from '@/lib/settings';
import { LookupSheet } from '@/reader/LookupSheet';
import { SelectionMenu } from '@/reader/SelectionMenu';
import { DialogHost, showActions, showPrompt } from '@/ui/dialogs';
import { ErrorScreen } from '@/ui/ErrorScreen';
import { StatsSheet } from '@/ui/StatsSheet';
import { DEVICES, type Device } from './check';
import { auditor } from './audit';
import { setDevice } from './env';

jest.mock('react-native-safe-area-context', () => require('./env').safeArea);
jest.mock('react-native/Libraries/Components/Keyboard/KeyboardAvoidingView', () => require('./env').kav);
jest.mock('@expo/vector-icons/Ionicons', () => require('./env').Icon);
// FlashList ships ES modules; React Native's FlatList lays a list out the same way.
jest.mock('@shopify/flash-list', () => ({ FlashList: require('react-native').FlatList }));
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({ id: 'a' }),
}));

const long = 'The Extraordinary and Remarkably Long-Winded Title of a Book That Never Seems to End';
const mockBooks = [
  { id: 'a', title: long, author: 'Somebody With A Very Long Name, and Another Author', fileName: 'a.epub', format: 'epub', size: 1_300_000, addedAt: 3, openedAt: 30, status: 'ready', progress: 1, percent: 0.25 },
  { id: 'b', title: 'Anna Karenina', author: 'Leo Tolstoy', fileName: 'anna.fb2', format: 'fb2', size: 2_400_000, addedAt: 2, openedAt: 10, status: 'ready', progress: 1, percent: 1, finished: true },
  { id: 'c', title: 'Converting now', author: '', fileName: 'c.txt', format: 'txt', size: 90_000_000, addedAt: 4, openedAt: 4, status: 'processing', progress: 0.4 },
  { id: 'd', title: 'Broken', author: '', fileName: 'd.mobi', size: 500, addedAt: 5, openedAt: 5, status: 'error', progress: 0, error: 'This book couldn’t be prepared.' },
  ...Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, title: `Book number ${i}`, author: 'Author', fileName: 'x.epub', format: 'epub', size: 1000, addedAt: 1, openedAt: 1, status: 'ready', progress: 1 })),
];
let mockList = mockBooks;
jest.mock('@/lib/library', () => ({
  useLibrary: () => mockList,
  useBook: (id: string) => mockList.find((b) => b.id === id),
  getBook: (id: string) => mockList.find((b) => b.id === id),
  useLiveBook: () => ({ chunks: [], totalBlocks: 0, totalChars: 0, progress: 0.4 }),
  loadManifest: () => ({ totalChars: 600_000, lang: 'en', format: 'epub' }),
  importBooks: jest.fn(),
  reprocessBook: jest.fn(),
  updateBook: jest.fn(),
  deleteBook: jest.fn(),
  renameBook: jest.fn(),
  restoreBookTitle: jest.fn(),
  coverUri: () => undefined,
}));
let mockAdding = false;
jest.mock('@/lib/openWith', () => ({ useAddingSharedFile: () => mockAdding }));
let mockUpdate: Record<string, unknown> = { kind: 'idle' };
jest.mock('@/lib/appUpdate', () => ({
  CURRENT_BUILD: 22,
  canSelfUpdate: () => true,
  checkForUpdate: () => Promise.resolve('none'),
  cleanOldDownloads: () => {},
  dismissUpdateError: () => {},
  installUpdate: () => {},
  snoozeUpdate: () => {},
  useUpdateState: () => mockUpdate,
}));
jest.mock('@/lib/lookup', () => ({
  ...jest.requireActual('@/lib/lookup'),
  defineWord: () =>
    Promise.resolve({
      word: 'perspicacious',
      language: 'English',
      source: 'Wiktionary',
      senses: [
        { pos: 'Adjective', defs: Array.from({ length: 6 }, (_, i) => ({ text: `Definition ${i}: having a ready insight into and understanding of things, showing keen mental perception.`, example: 'A perspicacious remark.' })) },
        { pos: 'Noun', defs: [{ text: 'Rare.' }] },
      ],
    }),
  translateText: () => Promise.resolve({ text: 'A fairly long translated sentence that wraps onto several lines of the card.', from: 'en' }),
}));

beforeAll(() => {
  require('./env').instantAnimations();
  addHighlight('a', { b: 3, s: 0, e: 16, color: 'yellow', text: 'Call me Ishmael. '.repeat(8), chapter: 'Loomings', note: 'A long note. '.repeat(10) });
  addHighlight('b', { b: 1, s: 0, e: 44, color: 'pink', text: 'Happy families are all alike', chapter: 'Part One' });
});

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
/** Screens under the navigation bar start below it. */
const header = (d: Device) => d.insets.top + (d.height > d.width ? 96 : 44);

const SIZES = ['phone', 'small', 'android', 'landscape', 'tablet'] as const;

describe.each(SIZES)('on %s', (size) => {
  const device = DEVICES[size];
  beforeEach(() => setDevice(device));

  it('library: grid, list, empty, update and adding states', async () => {
    const a = auditor(device);
    mockList = mockBooks;
    const view = await render(<Library />);
    await settle();
    await a.check('library grid', { headerHeight: header(device) });
    for (const s of [
      { kind: 'available', update: { build: 23, url: '', size: 40_000_000, notes: 'Notes' } },
      { kind: 'available', update: { build: 23, url: '', size: 40_000_000, notes: '' }, tried: true },
      { kind: 'downloading', update: { build: 23, url: '', size: 40_000_000, notes: '' }, progress: 0.5 },
      { kind: 'error', message: 'Couldn’t connect. Check the internet connection and try again.', update: { build: 23, url: '', size: 1, notes: '' } },
    ]) {
      mockUpdate = s;
      mockAdding = true;
      await view.rerender(<Library />);
      await settle();
      await a.check(`library, update ${s.kind}${'tried' in s ? ' (tried)' : ''}`, { headerHeight: header(device) });
    }
    mockUpdate = { kind: 'idle' };
    mockAdding = false;
    // The header's buttons are in the native navigation bar (not rendered here).
    await act(() => require('@/lib/collections').setView('list'));
    await settle();
    await a.check('library list', { headerHeight: header(device) });
    mockList = [];
    await view.rerender(<Library />);
    await settle();
    await a.check('library empty', { headerHeight: header(device) });
    mockList = mockBooks;
    await act(() => require('@/lib/collections').setView('grid'));
    expect(a.report()).toBe('');
  }, 60000);

  it('book details', async () => {
    const a = auditor(device);
    await render(<BookDetails />);
    await settle();
    await a.check('book details', { headerHeight: header(device) });
    expect(a.report()).toBe('');
  });

  it('highlights & notes', async () => {
    const a = auditor(device);
    await render(<NotesScreen />);
    await settle();
    await a.check('notes', { headerHeight: header(device) });
    expect(a.report()).toBe('');
  });

  it('menus and prompts', async () => {
    const a = auditor(device);
    await render(<DialogHost />);
    await act(() =>
      showActions(long, [
        ...Array.from({ length: 9 }, (_, i) => ({ label: `Action number ${i} with a longer label`, icon: 'albums-outline' as const, onPress: () => {} })),
        { label: 'Remove from library', icon: 'trash-outline', destructive: true, onPress: () => {} },
      ]),
    );
    await settle();
    await a.check('long action menu');
    await fireEvent.press(screen.getByText('Action number 0 with a longer label'));
    await settle();
    await act(() => showPrompt('Rename collection', { initial: 'A collection', onSubmit: () => {} }));
    await settle();
    await a.check('prompt');
    expect(a.report()).toBe('');
  });

  it('reading stats', async () => {
    const a = auditor(device);
    await render(<StatsSheet visible onClose={() => {}} />);
    await settle();
    await a.check('stats');
    expect(a.report()).toBe('');
  });

  it('dictionary and translation', async () => {
    const a = auditor(device);
    const view = await render(<LookupSheet lookup={{ kind: 'define', text: 'perspicacious' }} theme={THEMES.light} onChange={() => {}} />);
    await settle();
    await a.check('dictionary');
    await view.rerender(<LookupSheet lookup={{ kind: 'translate', text: 'perspicacious' }} theme={THEMES.light} onChange={() => {}} />);
    await settle();
    await a.check('translation');
    expect(a.report()).toBe('');
  });

  it('selection menu next to every edge of the screen', async () => {
    const a = auditor(device);
    const { width: W, height: H } = device;
    const spots = {
      'top left': { x: 4, y: device.insets.top + 4 },
      'top right': { x: W - 4, y: device.insets.top + 4 },
      middle: { x: W / 2, y: H / 2 },
      'bottom left': { x: 4, y: H - 40 },
      'bottom right': { x: W - 4, y: H - 40 },
    };
    for (const [where, p] of Object.entries(spots)) {
      const caret = { x: p.x, y: p.y, h: 22 };
      const view = await render(
        <View style={{ flex: 1 }}>
          <SelectionMenu start={caret} end={{ ...caret, x: Math.min(W - 2, caret.x + 40) }} canLookUp onCopy={() => {}} onLookUp={() => {}} onTranslate={() => {}} onShare={() => {}} />
        </View>,
      );
      await settle();
      await a.check(`selection menu, word at the ${where}`);
      await view.unmount();
    }
    expect(a.report()).toBe('');
  });

  it('error screen', async () => {
    const a = auditor(device);
    await render(
      <ErrorScreen
        title="This book couldn't be opened"
        message={'This book couldn’t be prepared. The file may be damaged or in a form this app can’t read. '.repeat(3)}
        actions={[
          { label: 'Try again', onPress: () => {}, primary: true },
          { label: 'Back to library', onPress: () => {} },
        ]}
      />,
    );
    await settle();
    await a.check('error screen');
    expect(a.report()).toBe('');
  });
});
