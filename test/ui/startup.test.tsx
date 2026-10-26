/// <reference types="jest" />
// Starting up: the splash screen stays until the icons' font has loaded (or a
// few seconds have passed), so no icon shows blank. And the screen shown after
// a crash while drawing can still update the app (Android APK).

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { ErrorScreen } from '@/ui/ErrorScreen';

let mockFonts: [boolean, Error | null] = [false, null];
let mockFontMap: unknown;
jest.mock('expo-font', () => ({
  useFonts: (map: unknown) => {
    mockFontMap = map;
    return mockFonts;
  },
  loadAsync: () => Promise.resolve(),
  isLoaded: () => true,
}));
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve(true)),
  hideAsync: jest.fn(() => Promise.resolve()),
}));
jest.mock('@expo/vector-icons/Ionicons', () => {
  const { createElement } = require('react');
  const { Text } = require('react-native');
  const Icon = (p: { name: string }) => createElement(Text, null, p.name);
  Icon.glyphMap = {};
  Icon.font = { ionicons: 'Ionicons.ttf' };
  return Icon;
});
jest.mock('expo-router', () => {
  const Stack = ({ children }: { children?: ReactNode }) => children ?? null;
  Stack.Screen = () => null;
  const theme = { dark: false, colors: {} };
  return { Stack, ThemeProvider: ({ children }: { children: ReactNode }) => children, DarkTheme: theme, DefaultTheme: theme, usePathname: () => '/' };
});
jest.mock('@/lib/openWith', () => ({ useSharedFileNavigation: () => {} }));
// The shelf isn't what's tested here (it loads from the phone's files).
jest.mock('@/lib/library', () => ({ loadLibrary: () => {}, flushLibrary: () => {}, deleteBook: () => {} }));
jest.mock('@/lib/migrations', () => ({ migrateStorage: () => {} }));

// The update store, as the screens see it.
type UpdateState = { kind: string; update?: { build: number; url: string; size: number; notes: string } };
let mockUpdateState: UpdateState = { kind: 'idle' };
const mockUpdateListeners = new Set<() => void>();
const mockSetUpdate = (s: UpdateState) => {
  mockUpdateState = s;
  mockUpdateListeners.forEach((l) => l());
};
let mockCanUpdate = true;
const mockCheck = jest.fn();
const mockInstall = jest.fn();
jest.mock('@/lib/appUpdate', () => ({
  CURRENT_BUILD: 30,
  canSelfUpdate: () => mockCanUpdate,
  checkForUpdate: (...a: unknown[]) => mockCheck(...a),
  installUpdate: (...a: unknown[]) => mockInstall(...a),
  cleanOldDownloads: () => {},
  dismissUpdateError: () => {},
  snoozeUpdate: () => {},
  useUpdateState: () =>
    require('react').useSyncExternalStore(
      (l: () => void) => {
        mockUpdateListeners.add(l);
        return () => mockUpdateListeners.delete(l);
      },
      () => mockUpdateState,
    ),
}));

const SplashScreen = jest.requireMock('expo-splash-screen') as { preventAutoHideAsync: jest.Mock; hideAsync: jest.Mock };
const { default: RootLayout, ErrorBoundary } = require('@/app/_layout') as typeof import('@/app/_layout');

afterEach(() => {
  jest.useRealTimers();
  SplashScreen.hideAsync.mockClear();
  mockFonts = [false, null];
  mockSetUpdate({ kind: 'idle' });
  mockCanUpdate = true;
  mockCheck.mockReset();
  mockInstall.mockReset();
});

describe('splash screen', () => {
  it('is kept up from the start, until the icons’ font has loaded', async () => {
    expect(SplashScreen.preventAutoHideAsync).toHaveBeenCalledTimes(1); // when the app's code loads
    const view = await render(<RootLayout />);
    expect(mockFontMap).toEqual({ ionicons: 'Ionicons.ttf' });
    expect(SplashScreen.hideAsync).not.toHaveBeenCalled();
    mockFonts = [true, null];
    await view.rerender(<RootLayout />);
    expect(SplashScreen.hideAsync).toHaveBeenCalled();
  });

  it('goes anyway if the font fails to load', async () => {
    mockFonts = [false, new Error('no font')];
    await render(<RootLayout />);
    expect(SplashScreen.hideAsync).toHaveBeenCalled();
  });

  it('goes after a few seconds if the font never loads', async () => {
    // Never fake setImmediate (it stalls jest on Node 22).
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    await render(<RootLayout />);
    await act(() => jest.advanceTimersByTime(2900));
    expect(SplashScreen.hideAsync).not.toHaveBeenCalled();
    await act(() => jest.advanceTimersByTime(200));
    expect(SplashScreen.hideAsync).toHaveBeenCalled();
  });
});

describe('the crash screen', () => {
  const update = { build: 31, url: 'https://x/app.apk', size: 40_000_000, notes: 'Fixes' };

  it('offers to check for updates, and says when this is the latest version', async () => {
    mockCheck.mockResolvedValue('none');
    await render(<ErrorBoundary error={new Error('Cannot read property x of undefined')} retry={async () => {}} />);
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    await fireEvent.press(screen.getByText('Check for updates'));
    expect(mockCheck).toHaveBeenLastCalledWith(true);
    expect(screen.getByText('This is the latest version (1.0.30).')).toBeTruthy();
  });

  it('a newer version found there can be installed from there', async () => {
    mockCheck.mockImplementation(async (manual?: boolean) => {
      if (!manual) return 'none';
      mockSetUpdate({ kind: 'available', update });
      return 'available';
    });
    await render(<ErrorBoundary error={new Error('boom')} retry={async () => {}} />);
    await fireEvent.press(screen.getByText('Check for updates'));
    expect(screen.getByText('New version available')).toBeTruthy();
    expect(screen.queryByText('Check for updates')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Update'));
    expect(mockInstall).toHaveBeenCalledWith(update);
  });

  it('isn’t offered where the app can’t update itself (iPhone, Expo Go), nor on other error screens', async () => {
    mockCanUpdate = false;
    const view = await render(<ErrorBoundary error={new Error('boom')} retry={async () => {}} />);
    expect(screen.queryByText('Check for updates')).toBeNull();
    await view.unmount();
    mockCanUpdate = true;
    await render(<ErrorScreen title="Book not found" actions={[{ label: 'Back to library', onPress: () => {}, primary: true }]} />);
    expect(screen.queryByText('Check for updates')).toBeNull();
  });
});
