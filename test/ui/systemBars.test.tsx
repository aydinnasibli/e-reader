/// <reference types="jest" />
// While reading, the phone's own bars are out of the way: Android's
// navigation bar is hidden and the iPhone's home indicator fades; both come
// back with the menu.

import { render } from '@testing-library/react-native';
import { SystemBars } from '@/reader/SystemBars';

jest.unmock('@/reader/SystemBars');
const mockScreen = jest.fn((_: unknown) => null);
const mockNavBar = jest.fn((_: unknown) => null);
jest.mock('expo-router', () => ({ Stack: { Screen: (p: unknown) => mockScreen(p) } }));
jest.mock('expo-navigation-bar', () => ({ NavigationBar: (p: unknown) => mockNavBar(p) }));

it('hidden while reading, shown with the menu', async () => {
  const view = await render(<SystemBars shown={false} dark />);
  expect(mockNavBar).toHaveBeenLastCalledWith({ hidden: true, style: 'light' });
  expect(mockScreen).toHaveBeenLastCalledWith({ options: { autoHideHomeIndicator: true } });
  await view.rerender(<SystemBars shown dark={false} />);
  expect(mockNavBar).toHaveBeenLastCalledWith({ hidden: false, style: 'dark' });
  expect(mockScreen).toHaveBeenLastCalledWith({ options: { autoHideHomeIndicator: false } });
});
