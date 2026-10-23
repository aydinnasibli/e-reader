/// <reference types="jest" />
// Deleting things that can't be brought back asks first and says what goes;
// notes and authors can be cleared.

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';
import type { Block } from '@/engine/types';
import { addBookmark, addHighlight, getAnnotations } from '@/lib/annotations';
import { THEMES } from '@/lib/settings';
import { annotationsSummary, confirmRemoveBook } from '@/ui/confirm';
import { DialogHost, showPrompt } from '@/ui/dialogs';

jest.mock('@/lib/library', () => ({ deleteBook: jest.fn() }));

const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
/** Press a button of the last alert shown. */
const pressAlert = async (text: string) => {
  const buttons = alert.mock.calls.at(-1)?.[2] as AlertButton[];
  await act(() => buttons.find((b) => b.text === text)?.onPress?.());
};
beforeEach(() => alert.mockClear());

const TEXT = 'The quick brown fox jumps over the lazy dog';
const block: Block = { k: 'p', r: [TEXT] };

it('removing a book says which highlights, notes and bookmarks go with it', async () => {
  expect(annotationsSummary('empty')).toBeNull();
  addHighlight('b1', { b: 0, s: 0, e: 3, color: 'yellow', text: 'The' });
  addHighlight('b1', { b: 0, s: 4, e: 9, color: 'yellow', text: 'quick', note: 'fast' });
  addBookmark('b1', { b: 0, o: 0, snippet: 'The' });
  expect(annotationsSummary('b1')).toBe('its 2 highlights (1 with a note) and 1 bookmark');

  const { deleteBook } = jest.requireMock('@/lib/library') as { deleteBook: jest.Mock };
  confirmRemoveBook({ id: 'b1', title: 'Moby-Dick' } as never);
  expect(alert.mock.calls[0][1]).toContain('with its 2 highlights (1 with a note) and 1 bookmark');
  expect(deleteBook).not.toHaveBeenCalled(); // nothing happens until confirmed
  await pressAlert('Remove');
  expect(deleteBook).toHaveBeenCalledWith('b1');
});

it('a field that may be cleared saves empty; others ignore an empty save', async () => {
  await render(<DialogHost />);
  const save = jest.fn();
  await act(() => showPrompt('Author', { initial: 'Melville', allowEmpty: true, onSubmit: save }));
  await fireEvent.changeText(screen.getByDisplayValue('Melville'), '  ');
  await fireEvent.press(screen.getByText('Save'));
  expect(save).toHaveBeenCalledWith('');

  const title = jest.fn();
  await act(() => showPrompt('Title', { initial: 'Moby-Dick', onSubmit: title }));
  await fireEvent.changeText(screen.getByDisplayValue('Moby-Dick'), '');
  await fireEvent.press(screen.getByText('Save'));
  expect(title).not.toHaveBeenCalled();
});
