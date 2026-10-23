/// <reference types="jest" />
// Screen readers: page mode can be read and turned without swipes or taps
// (VoiceOver/TalkBack take those), and buttons are announced as buttons.

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { Block, Manifest } from '@/engine/types';
import { setSettings } from '@/lib/settings';
import ReaderScreen from '@/app/reader/[id]';
import { Tap } from '@/ui/Tap';
import { Text } from 'react-native';

const para = (i: number) => `Paragraph ${i}. ` + 'The sea was calm and the sky was wide, and the ship went on through the night. '.repeat(4);
const blocks: Block[] = Array.from({ length: 40 }, (_, i) => ({ k: 'p', r: [para(i)] }));
const total = blocks.reduce((n, b) => n + (b.r![0] as string).length, 0);
const manifest: Manifest = { v: 1, format: 'txt', title: 'Sea', author: '', totalBlocks: blocks.length, totalChars: total, chunks: [[0, 0]], toc: [], images: {} };

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'sea' }), router: { back: jest.fn() } }));
jest.mock('expo-screen-orientation', () => ({ lockAsync: () => Promise.resolve(), OrientationLock: {} }));
jest.mock('@/lib/library', () => {
  const entry = { id: 'sea', title: 'Sea', author: '', status: 'ready', format: 'txt', position: { b: 0, o: 0 } };
  return {
    getBook: () => entry,
    loadManifest: () => require('./a11y.test').manifestForMock,
    useBookStatus: () => 'ready',
    useLiveBook: () => undefined,
    updateBook: () => {},
    reprocessBook: () => {},
    sourceFile: () => ({}),
  };
});
export const manifestForMock = manifest;

beforeAll(async () => {
  require('@/lib/storage').testChunks.set('sea/0', JSON.stringify({ b: blocks }));
});

/** The page on screen: the adjustable element not hidden from screen readers. */
const page = () =>
  screen.container.queryAll(
    (n) => n.props.accessibilityRole === 'adjustable' && typeof n.props.onAccessibilityAction === 'function',
  ).find((n: { parent: any }) => {
    for (let p = n.parent; p; p = p.parent) if (p.props.accessibilityElementsHidden) return false;
    return true;
  })!;

it('the page is adjustable: screen-reader actions turn it forward and back and open the menu', async () => {
  setSettings({ mode: 'page', seenTapZones: true, pageTurn: 'none', hyphenate: false });
  await render(<ReaderScreen />);
  await waitFor(() => expect(screen.getByText(/^1 of \d+ · /)).toBeTruthy(), { timeout: 9000 });
  expect(page().props.accessibilityValue.text).toMatch(/^1 of \d+$/);
  expect(page().props.accessibilityActions.map((a: { name: string }) => a.name)).toEqual(
    expect.arrayContaining(['increment', 'decrement', 'activate']),
  );

  await fireEvent(page(), 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
  await waitFor(() => expect(screen.getByText(/^2 of \d+ · /)).toBeTruthy(), { timeout: 8000 });
  expect(page().props.accessibilityValue.text).toMatch(/^2 of \d+$/);

  await fireEvent(page(), 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } });
  await waitFor(() => expect(screen.getByText(/^1 of \d+ · /)).toBeTruthy(), { timeout: 8000 });

  await fireEvent(page(), 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
  expect(screen.getByLabelText('Display')).toBeTruthy();
}, 40000);

it('buttons are announced as buttons, unless they say otherwise', async () => {
  await render(
    <>
      <Tap onPress={() => {}} accessibilityLabel="Add books">
        <Text>+</Text>
      </Tap>
      <Tap onPress={() => {}} accessibilityLabel="Night" accessibilityRole="tab">
        <Text>N</Text>
      </Tap>
    </>,
  );
  expect(screen.getByRole('button', { name: 'Add books' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Night' })).toBeTruthy();
});
