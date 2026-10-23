/// <reference types="jest" />
// Deleting things that can't be brought back asks first and says what goes;
// notes and authors can be cleared.

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';
import type { Block } from '@/engine/types';
import { addBookmark, addHighlight, getAnnotations } from '@/lib/annotations';
import { THEMES } from '@/lib/settings';
import { SelectionSheet } from '@/reader/SelectionSheet';
import { annotationsSummary, confirmRemoveBook } from '@/ui/confirm';
import { DialogHost, showPrompt } from '@/ui/dialogs';

jest.mock('@/lib/library', () => ({ deleteBook: jest.fn() }));

const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
/** Press a button of the last alert shown. */
const pressAlert = (text: string) => {
  const buttons = alert.mock.calls.at(-1)?.[2] as AlertButton[];
  act(() => buttons.find((b) => b.text === text)?.onPress?.());
};
beforeEach(() => alert.mockClear());

const TEXT = 'The quick brown fox jumps over the lazy dog';
const block: Block = { k: 'p', r: [TEXT] };

it('removing a book says which highlights, notes and bookmarks go with it', () => {
  expect(annotationsSummary('empty')).toBeNull();
  addHighlight('b1', { b: 0, s: 0, e: 3, color: 'yellow', text: 'The' });
  addHighlight('b1', { b: 0, s: 4, e: 9, color: 'yellow', text: 'quick', note: 'fast' });
  addBookmark('b1', { b: 0, o: 0, snippet: 'The' });
  expect(annotationsSummary('b1')).toBe('its 2 highlights (1 with a note) and 1 bookmark');

  const { deleteBook } = jest.requireMock('@/lib/library') as { deleteBook: jest.Mock };
  confirmRemoveBook({ id: 'b1', title: 'Moby-Dick' } as never);
  expect(alert.mock.calls[0][1]).toContain('with its 2 highlights (1 with a note) and 1 bookmark');
  expect(deleteBook).not.toHaveBeenCalled(); // nothing happens until confirmed
  pressAlert('Remove');
  expect(deleteBook).toHaveBeenCalledWith('b1');
});

it('removing a highlight that has a note asks first; plain highlighting goes at once', () => {
  addHighlight('b2', { b: 0, s: 16, e: 19, color: 'yellow', text: 'fox', note: 'clever' });
  addHighlight('b2', { b: 0, s: 40, e: 43, color: 'green', text: 'dog' });
  const props = { bookId: 'b2', bookTitle: 'Book', theme: THEMES.light, onClose: () => {} };

  const first = render(<SelectionSheet {...props} target={{ b: 0, block, at: TEXT.indexOf('dog') }} />);
  fireEvent.press(screen.getByLabelText('Remove highlight'));
  expect(alert).not.toHaveBeenCalled();
  expect(getAnnotations('b2').highlights.map((h) => h.text)).toEqual(['fox']);
  first.unmount();

  render(<SelectionSheet {...props} target={{ b: 0, block, at: TEXT.indexOf('fox') }} />);
  fireEvent.press(screen.getByLabelText('Remove highlight'));
  expect(alert.mock.calls[0][0]).toBe('Delete highlight and its note?');
  expect(getAnnotations('b2').highlights).toHaveLength(1);
  pressAlert('Delete');
  expect(getAnnotations('b2').highlights).toHaveLength(0);
});

it('a field that may be cleared saves empty; others ignore an empty save', () => {
  render(<DialogHost />);
  const save = jest.fn();
  act(() => showPrompt('Author', { initial: 'Melville', allowEmpty: true, onSubmit: save }));
  fireEvent.changeText(screen.getByDisplayValue('Melville'), '  ');
  fireEvent.press(screen.getByText('Save'));
  expect(save).toHaveBeenCalledWith('');

  const title = jest.fn();
  act(() => showPrompt('Title', { initial: 'Moby-Dick', onSubmit: title }));
  fireEvent.changeText(screen.getByDisplayValue('Moby-Dick'), '');
  fireEvent.press(screen.getByText('Save'));
  expect(title).not.toHaveBeenCalled();
});
