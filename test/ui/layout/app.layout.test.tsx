/// <reference types="jest" />
// The library, book details, highlights & notes, menus and prompts, reading
// stats, the dictionary/translation sheet and the selection menu, laid out on
// phones of several sizes, in landscape and on a tablet both ways round, at
// larger text sizes and with the keyboard open (see check.ts). The app's own
// screens also keep every button at least 44 points to the finger; book
// details and highlights & notes keep lines readable on wide screens.

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
import { COLUMN_WIDTH } from '@/ui/layout';
import { StatsSheet } from '@/ui/StatsSheet';
import { DEVICES, type Device, type Laid, checkLayout } from './check';
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
  setBookLanguage: jest.fn(),
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
  translateText: () => Promise.resolve({ text: 'A fairly long translated sentence that wraps onto several lines of the card.', from: 'en', source: 'Google Translate' }),
}));

beforeAll(() => {
  require('./env').instantAnimations();
  addHighlight('a', { b: 3, s: 0, e: 16, color: 'yellow', text: 'Call me Ishmael. '.repeat(8), chapter: 'Loomings', note: 'A long note. '.repeat(10) });
  addHighlight('b', { b: 1, s: 0, e: 44, color: 'pink', text: 'Happy families are all alike', chapter: 'Part One' });
});

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
/** Screens under the navigation bar start below it. */
const header = (d: Device) => d.insets.top + (d.height > d.width ? 96 : 44);
/**
 * Buttons a finger can hit (Apple's 44 points), and lines of a readable length:
 * a column of COLUMN_WIDTH (about Apple's readable width) sets small text in
 * lines of 80-odd characters; edge to edge on a tablet it was 120 and more.
 */
const APP = { minTarget: 44 };
const READABLE = { ...APP, maxLineChars: 85 };

/** Where everything on the screen is now. */
async function laidOut(device: Device) {
  const laid: Laid[] = [];
  await checkLayout(screen.toJSON(), device, { headerHeight: header(device), laidOut: laid });
  return laid;
}

/** The box of the sheet or menu open now (the first view in it, after the dimmed backdrop). */
async function sheetBox(device: Device) {
  return (await laidOut(device)).find((l) => l.layer > 0 && l.kind === 'view' && l.label !== 'View "__kav"')!;
}

/** Content in a column at most COLUMN_WIDTH wide, centred; on a phone held upright, as wide as before. */
function expectColumn(device: Device, box: Laid, gutter: number) {
  const left = box.rect.x;
  const right = device.width - box.rect.x - box.rect.w;
  if (device.width - device.insets.left - device.insets.right - 2 * gutter <= COLUMN_WIDTH) {
    expect(Math.round(left)).toBe(device.insets.left + gutter);
    expect(Math.round(right)).toBe(device.insets.right + gutter);
  } else {
    expect(box.rect.w).toBeLessThanOrEqual(COLUMN_WIDTH + 0.5);
    expect(Math.abs(left - right)).toBeLessThan(1);
  }
}

/** Grid columns: three on a phone, more as the screen gets wider (books about 150 points wide). */
const COLUMNS = { phone: 3, small: 3, android: 3, landscape: 5, tablet: 6, tabletLandscape: 8 };

const SIZES = ['phone', 'small', 'android', 'landscape', 'tablet', 'tabletLandscape'] as const;

describe.each(SIZES)('on %s', (size) => {
  const device = DEVICES[size];
  beforeEach(() => setDevice(device));

  it('library: grid, list, empty, update and adding states', async () => {
    const a = auditor(device);
    mockList = mockBooks;
    const view = await render(<Library />);
    await settle();
    await a.check('library grid', { headerHeight: header(device), ...APP });
    // The books' buttons, one per cell: as many places across as columns.
    const laid = await laidOut(device);
    const cells = laid.filter((l) => l.kind === 'touch' && /^View "Book number \d+/.test(l.label));
    expect(new Set(cells.map((l) => Math.round(l.rect.x))).size).toBe(COLUMNS[size]);
    // "Continue reading": across a phone; on wider screens whole grid columns, no wider than the shared column.
    const card = laid.find((l) => l.label.startsWith('View "Continue reading: '))!;
    const across = device.width - device.insets.left - device.insets.right - 32;
    expect(Math.round(card.rect.x)).toBe(Math.round(Math.min(...cells.map((l) => l.rect.x))));
    if (across <= COLUMN_WIDTH) expect(Math.round(card.rect.w)).toBe(Math.round(across));
    else {
      expect(card.rect.w).toBeLessThanOrEqual(COLUMN_WIDTH + 0.5);
      expect(cells.some((l) => Math.abs(l.rect.x + l.rect.w - card.rect.x - card.rect.w) < 1)).toBe(true);
    }
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
      await a.check(`library, update ${s.kind}${'tried' in s ? ' (tried)' : ''}`, { headerHeight: header(device), ...APP });
    }
    mockUpdate = { kind: 'idle' };
    mockAdding = false;
    // The header's buttons are in the native navigation bar (not rendered here).
    await act(() => require('@/lib/collections').setView('list'));
    await settle();
    await a.check('library list', { headerHeight: header(device), ...APP });
    mockList = [];
    await view.rerender(<Library />);
    await settle();
    await a.check('library empty', { headerHeight: header(device), ...APP });
    mockList = mockBooks;
    await act(() => require('@/lib/collections').setView('grid'));
    expect(a.report()).toBe('');
  }, 60000);

  it('book details', async () => {
    const a = auditor(device);
    const view = await render(<BookDetails />);
    await settle();
    await a.check('book details', { headerHeight: header(device), ...READABLE });
    expectColumn(device, (await laidOut(device)).find((l) => l.label === 'View "Continue reading"')!, 20);
    // A title edited by hand: the link back to the book's own.
    mockList = mockBooks.map((b) => (b.id === 'a' ? { ...b, titleEdited: true } : b));
    await view.rerender(<BookDetails />);
    await settle();
    expect(screen.getByText('Use the book’s own title')).toBeTruthy();
    await a.check('book details, title edited', { headerHeight: header(device), ...READABLE });
    mockList = mockBooks;
    expect(a.report()).toBe('');
  });

  it('highlights & notes', async () => {
    const a = auditor(device);
    await render(<NotesScreen />);
    await settle();
    await a.check('notes', { headerHeight: header(device), ...READABLE });
    expect(a.report()).toBe('');
    // The search box lines up with the highlights below it, in the column.
    const laid = await laidOut(device);
    const search = laid.find((l) => l.label === 'TextInput "Search highlights and notes"')!;
    const row = laid.find((l) => l.kind === 'touch' && l.label.startsWith('View "Call me Ishmael.'))!;
    expect(search.rect.x).toBeGreaterThanOrEqual(row.rect.x);
    expectColumn(device, row, 16);
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
    await a.check('long action menu', APP);
    // A bottom sheet: across a phone; a centred column on wider screens, clear of the notch.
    expectColumn(device, await sheetBox(device), 0);
    await fireEvent.press(screen.getByText('Action number 0 with a longer label'));
    await settle();
    await act(() => showPrompt('Rename collection', { initial: 'A collection', onSubmit: () => {} }));
    await settle();
    await a.check('prompt', APP);
    // The prompt's card keeps 12 points off the edges.
    expectColumn(device, await sheetBox(device), 12);
    expect(a.report()).toBe('');
  });

  it('reading stats', async () => {
    const a = auditor(device);
    await render(<StatsSheet visible onClose={() => {}} />);
    await settle();
    await a.check('stats', READABLE);
    expectColumn(device, await sheetBox(device), 0);
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
    await a.check('error screen', APP);
    expect(a.report()).toBe('');
  });
});
