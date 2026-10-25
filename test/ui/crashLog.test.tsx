/// <reference types="jest" />
// The crash log in the library: listed in the View menu once something was
// recorded, shown with share and clear, and pointed out once after the app was
// closed by an error.

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Alert } from 'react-native';
import Library from '@/app/index';
import { installCrashHandlers, recordCrash } from '@/lib/crashLog';
import { noteLastCrash } from '@/ui/crashDialogs';
import type { Action } from '@/ui/dialogs';

const mockShare = jest.fn();
const mockActions = jest.fn();

// The header's buttons are drawn, so the View menu can be opened.
jest.mock('expo-router', () => ({
  Stack: { Screen: ({ options }: { options?: { headerRight?: () => ReactNode } }) => options?.headerRight?.() ?? null },
  router: { push: jest.fn() },
}));
jest.mock('@shopify/flash-list', () => ({ FlashList: require('react-native').FlatList }));
jest.mock('@/lib/library', () => ({ useLibrary: () => [], useLiveBook: () => undefined, importBooks: jest.fn(), reprocessBook: jest.fn(), updateBook: jest.fn() }));
jest.mock('@/lib/openWith', () => ({ useAddingSharedFile: () => false }));
jest.mock('@/lib/appUpdate', () => ({ CURRENT_BUILD: 0, canSelfUpdate: () => false, checkForUpdate: jest.fn(), useUpdateState: () => ({ kind: 'idle' }) }));
jest.mock('@/lib/shareText', () => ({ shareTextFile: (...a: unknown[]) => mockShare(...a) }));
jest.mock('@/ui/dialogs', () => ({ showActions: (...a: unknown[]) => mockActions(...a), showPrompt: jest.fn() }));

const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
type Button = { text: string; onPress?: () => void };
const lastAlert = () => alert.mock.calls[alert.mock.calls.length - 1] as [string, string, Button[]];
const button = (text: string) => lastAlert()[2].find((b) => b.text === text)!;

async function viewMenu(): Promise<Action[]> {
  mockActions.mockClear();
  await fireEvent.press(screen.getByLabelText('View options'));
  return mockActions.mock.calls[0][1];
}

it('the View menu lists the crash log once something is recorded; it can be shared and cleared', async () => {
  await render(<Library />);
  expect((await viewMenu()).some((a) => a.label.startsWith('Crash log'))).toBe(false);

  await act(async () => recordCrash('screen', new TypeError('Cannot read property blocks of undefined')));
  const item = (await viewMenu()).find((a) => a.label === 'Crash log (1)');
  expect(item).toBeTruthy();

  item!.onPress();
  expect(lastAlert()[0]).toBe('Crash log');
  expect(lastAlert()[1]).toContain('TypeError: Cannot read property blocks of undefined');
  button('Share').onPress!();
  expect(mockShare).toHaveBeenCalledWith('nec-reader-crash-log.txt', expect.stringContaining('error page shown'), 'text/plain');

  await act(async () => button('Clear').onPress!());
  expect((await viewMenu()).some((a) => a.label.startsWith('Crash log'))).toBe(false);
});

it('after the app was closed by an error, the next start says so once', () => {
  let handler: ((e: unknown, fatal?: boolean) => void) | undefined;
  const g = globalThis as { ErrorUtils?: unknown };
  const saved = g.ErrorUtils;
  g.ErrorUtils = { getGlobalHandler: () => undefined, setGlobalHandler: (h: typeof handler) => (handler = h) };
  try {
    installCrashHandlers(undefined, true);
    handler!(new RangeError('Maximum call stack size exceeded'), true);
  } finally {
    g.ErrorUtils = saved;
  }
  alert.mockClear();
  noteLastCrash();
  expect(lastAlert()[0]).toBe('The app closed because of an error');
  expect(lastAlert()[1]).toContain('RangeError: Maximum call stack size exceeded');
  noteLastCrash();
  expect(alert).toHaveBeenCalledTimes(1);
});
