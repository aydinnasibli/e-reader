/// <reference types="jest" />
// Menus and prompts (DialogHost). One that closes keeps what it showed while
// it animates away: it used to go blank at once, and a prompt's card at the
// top turned into an empty bottom sheet as it faded. Only the open one acts.
// A menu's toggles say whether they're on, and its icons aren't read out.

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Keyboard } from 'react-native';
import { DialogHost, showActions, showPrompt } from '@/ui/dialogs';

// The sheet as it's told to be drawn (open or closing, where, with what
// title); what's in it is always drawn here, as a closing Modal still does.
const mockSheet: { visible?: boolean; title?: string; position?: string } = {};
jest.mock('@/ui/Sheet', () => ({
  Sheet: ({ visible, title, position, children }: { visible: boolean; title?: string; position?: string; children: unknown }) => {
    Object.assign(mockSheet, { visible, title, position });
    return children;
  },
}));
// Icons as their names, with their props (whether they're hidden from screen readers).
jest.mock('@expo/vector-icons/Ionicons', () => {
  const { createElement } = require('react');
  const { Text } = require('react-native');
  const Icon = (p: { name: string }) => createElement(Text, p, p.name);
  Icon.glyphMap = {};
  return Icon;
});

type Node = { props: Record<string, unknown>; children: (Node | string)[] };
const textIn = (n: Node | string): string => (typeof n === 'string' ? n : n.children.map(textIn).join(''));

beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate'] }));
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('a menu keeps its title and rows while it closes, and a second tap meanwhile does nothing', async () => {
  await render(<DialogHost />);
  const details = jest.fn();
  await act(() => showActions('Moby-Dick', [{ label: 'Details', onPress: details }]));
  expect(mockSheet).toEqual({ visible: true, title: 'Moby-Dick', position: 'bottom' });
  await fireEvent.press(screen.getByText('Details'));
  expect(mockSheet).toEqual({ visible: false, title: 'Moby-Dick', position: 'bottom' });
  expect(screen.getByText('Details')).toBeTruthy();
  await fireEvent.press(screen.getByText('Details'));
  await act(() => jest.advanceTimersByTime(300));
  expect(details).toHaveBeenCalledTimes(1);
});

it('a prompt stays a card at the top while it fades, the keyboard goes at once, and it saves once', async () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss');
  await render(<DialogHost />);
  const save = jest.fn();
  await act(() => showPrompt('Rename collection', { initial: 'Novels', onSubmit: save }));
  expect(mockSheet).toEqual({ visible: true, title: 'Rename collection', position: 'top' });
  await fireEvent.press(screen.getByText('Save'));
  expect(save).toHaveBeenCalledWith('Novels');
  expect(mockSheet).toEqual({ visible: false, title: 'Rename collection', position: 'top' });
  expect(screen.getByDisplayValue('Novels')).toBeTruthy();
  expect(dismiss).toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Save'));
  expect(save).toHaveBeenCalledTimes(1);
});

it('the next dialog replaces the one that closed', async () => {
  await render(<DialogHost />);
  await act(() => showActions('Moby-Dick', [{ label: 'Add to collection…', onPress: () => showActions('Collections', [{ label: 'Novels', onPress: () => {} }]) }]));
  await fireEvent.press(screen.getByText('Add to collection…'));
  await act(() => jest.advanceTimersByTime(300));
  expect(mockSheet).toEqual({ visible: true, title: 'Collections', position: 'bottom' });
  expect(screen.queryByText('Add to collection…')).toBeNull();
  expect(screen.getByText('Novels')).toBeTruthy();
});

it('a menu’s toggles say whether they are on; its icons and tick aren’t read out', async () => {
  await render(<DialogHost />);
  await act(() =>
    showActions('View', [
      { label: 'Grid', icon: 'grid-outline', checked: true, onPress: () => {} },
      { label: 'List', icon: 'list-outline', checked: false, onPress: () => {} },
      { label: 'Back up highlights & notes', icon: 'share-outline', onPress: () => {} },
    ]),
  );
  const states = new Map<string, unknown>();
  for (const n of screen.container.queryAll((n) => n.props.accessibilityState !== undefined) as unknown as Node[]) {
    states.set(textIn(n), (n.props.accessibilityState as { checked?: boolean }).checked);
  }
  // Only the toggles are checked or not (the row's text is its label, the hidden icons aside).
  expect([...states]).toEqual([
    ['grid-outlineGridcheckmark', true],
    ['list-outlineList', false],
    ['share-outlineBack up highlights & notes', undefined],
  ]);
  for (const icon of ['grid-outline', 'list-outline', 'share-outline', 'checkmark']) {
    expect([icon, screen.queryByText(icon)]).toEqual([icon, null]);
    expect(screen.getByText(icon, { includeHiddenElements: true })).toBeTruthy();
  }
});
