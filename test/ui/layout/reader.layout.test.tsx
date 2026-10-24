/// <reference types="jest" />
// The reader and every panel it opens, laid out on phones of several sizes,
// in landscape and on a tablet, at larger text sizes and with the keyboard
// open: nothing may end up off the screen, under the status bar or keyboard,
// cut off, or on top of something else (see check.ts).

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Dimensions } from 'react-native';
import type { Block, Manifest } from '@/engine/types';
import { addBookmark, addHighlight } from '@/lib/annotations';
import { setSettings } from '@/lib/settings';
import ReaderScreen from '@/app/reader/[id]';
import { DEVICES } from './check';
import { auditor } from './audit';
import { setDevice } from './env';

jest.mock('react-native-safe-area-context', () => require('./env').safeArea);
jest.mock('react-native/Libraries/Components/Keyboard/KeyboardAvoidingView', () => require('./env').kav);
jest.mock('@expo/vector-icons/Ionicons', () => require('./env').Icon);
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'sea' }), router: { back: jest.fn() } }));
jest.mock('expo-screen-orientation', () => ({ lockAsync: () => Promise.resolve(), OrientationLock: {} }));

const para = (i: number) => `Paragraph ${i}. ` + 'The sea was calm and the sky was wide, and the ship went on through the night. '.repeat(4);
const blocks: Block[] = [
  { k: 'h', l: 1, r: ['Chapter One: A Rather Long Chapter Title That Goes On and On'] },
  ...Array.from({ length: 40 }, (_, i): Block => ({ k: 'p', r: [para(i)] })),
];
const total = blocks.reduce((n, b) => n + (b.r![0] as string).length, 0);
const manifest: Manifest = {
  v: 1,
  format: 'txt',
  title: 'The Sea and the Sky: A Very Long Book Title for a Small Screen',
  author: 'A. Sailor',
  totalBlocks: blocks.length,
  totalChars: total,
  chunks: [[0, 0]],
  toc: Array.from({ length: 30 }, (_, i) => ({ t: `Chapter ${i + 1}: ${'Long title '.repeat(i % 4 + 1)}`, l: i % 3 === 2 ? 1 : 0, b: Math.min(i, 40) })),
  images: {},
};

jest.mock('@/lib/library', () => {
  const entry = { id: 'sea', title: 'The Sea and the Sky: A Very Long Book Title for a Small Screen', author: 'A. Sailor', status: 'ready', format: 'txt', position: { b: 0, o: 0 } };
  return {
    getBook: () => entry,
    loadManifest: () => require('./reader.layout.test').manifestForMock,
    useBookStatus: () => 'ready',
    useLiveBook: () => undefined,
    updateBook: () => {},
    reprocessBook: () => {},
    sourceFile: () => ({}),
  };
});
export const manifestForMock = manifest;

beforeAll(() => {
  require('./env').instantAnimations();
  require('@/lib/storage').testChunks.set('sea/0', JSON.stringify({ b: blocks }));
  addBookmark('sea', { b: 3, o: 0, snippet: para(3).slice(0, 140), chapter: 'Chapter One: A Rather Long Chapter Title That Goes On and On' });
  addHighlight('sea', { b: 5, s: 0, e: 60, color: 'yellow', text: para(5).slice(0, 60), note: 'A note that is long enough to wrap onto a few lines in the list.', chapter: 'Chapter One' });
});

const settle = () => act(() => new Promise((r) => setTimeout(r, 450))); // panel animations
const tapMiddle = async () => {
  const { width, height } = Dimensions.get('window');
  await fireEvent.press(screen.getAllByText(/^Paragraph \d+\./)[0], { nativeEvent: { pageX: width / 2, pageY: height / 2 } });
  await settle();
};

/** The menu, if it isn't showing already (closing a panel leaves it open). */
const menu = async () => {
  if (!screen.queryByLabelText('Search')) await tapMiddle();
};

const SIZES = ['phone', 'small', 'android', 'landscape', 'tablet'] as const;

it.each(SIZES)('reader on %s', async (size) => {
  const device = DEVICES[size];
  setDevice(device);
  setSettings({ mode: 'page', seenTapZones: true, pageTurn: 'none', hyphenate: false, fontSize: 19, theme: 'light', autoNight: false });
  const a = auditor(device);
  await render(<ReaderScreen />);
  await waitFor(() => expect(screen.getByText(/^1 of \d+ · /)).toBeTruthy(), { timeout: 9000 });
  await a.check('page');

  await tapMiddle();
  await a.check('menu');

  await fireEvent.press(screen.getByLabelText('Display'));
  await settle();
  for (const tab of ['Text', 'Spacing', 'Colours', 'Page']) {
    await fireEvent.press(screen.getByText(tab));
    await settle();
    await a.check(`display: ${tab}`);
  }
  await fireEvent.press(screen.getByLabelText('Close'));
  await settle();

  await menu();
  await fireEvent.press(screen.getByLabelText('Contents'));
  await settle();
  for (const tab of ['Contents', 'Bookmarks', 'Highlights']) {
    await fireEvent.press(screen.getAllByText(new RegExp(`^${tab}`)).at(-1)!);
    await settle();
    await a.check(`navigator: ${tab}`);
  }
  await fireEvent.press(screen.getAllByLabelText('Close')[0]);
  await settle();

  await menu();
  await fireEvent.press(screen.getByLabelText('Search'));
  await settle();
  await a.check('search');
  await fireEvent.changeText(screen.getByPlaceholderText('Search in book'), 'ship');
  await fireEvent(screen.getByPlaceholderText('Search in book'), 'submitEditing');
  await waitFor(() => expect(screen.getByText(/results?$/)).toBeTruthy(), { timeout: 5000 });
  await a.check('search results');
  await fireEvent.press(screen.getAllByLabelText('Close')[0]);
  await settle();

  await menu();
  await fireEvent.press(screen.getByLabelText('Go to page'));
  await settle();
  await a.check('go to page');
  await fireEvent.press(screen.getAllByLabelText('Close')[0]);
  await settle();

  await menu();
  await fireEvent.press(screen.getByLabelText('Highlight'));
  await settle();
  await a.check('highlight tool');
  await fireEvent.press(screen.getByLabelText('Done highlighting'));
  await settle();

  await menu();
  await fireEvent.press(screen.getByLabelText('Auto page turn'));
  await settle();
  await a.check('auto page turn');
  await fireEvent.press(screen.getByLabelText('Stop'));
  await settle();

  // "Back to page …" after a jump.
  await menu();
  await fireEvent.press(screen.getByLabelText('Next chapter'));
  await settle();
  await a.check('back chip');

  setSettings({ seenTapZones: false });
  await settle();
  await a.check('tap zone guide');
  setSettings({ seenTapZones: true });

  expect(a.report()).toBe('');
}, 120000);

it.each(['phone', 'landscape'] as const)('scroll mode on %s', async (size) => {
  const device = DEVICES[size];
  setDevice(device);
  setSettings({ mode: 'scroll', seenTapZones: true, hyphenate: false, fontSize: 19 });
  const a = auditor(device);
  await render(<ReaderScreen />);
  await waitFor(() => expect(screen.getAllByText(/^Paragraph 0\./).length).toBeGreaterThan(0), { timeout: 9000 });
  await a.check('scroll page');
  await tapMiddle();
  await a.check('scroll menu');
  setSettings({ mode: 'page' });
  expect(a.report()).toBe('');
}, 60000);
