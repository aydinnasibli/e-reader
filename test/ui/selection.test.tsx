/// <reference types="jest" />
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { Block } from '@/engine/types';
import { getAnnotations } from '@/lib/annotations';
import { THEMES } from '@/lib/settings';
import { SelectionSheet } from '@/reader/SelectionSheet';

const TEXT = 'The quick brown fox jumps over the lazy dog';
const block: Block = { k: 'p', r: [TEXT] };
const theme = THEMES.light;
const SELECTED = theme.accent + '55';

const at = (word: string) => TEXT.indexOf(word) + 1;
const highlights = (book: string) => getAnnotations(book).highlights.map((h) => [h.text, h.color]);

function open(book: string, pressed?: string) {
  const onClose = jest.fn();
  const target = { b: 0, block, at: pressed ? at(pressed) : undefined };
  const utils = render(<SelectionSheet bookId={book} bookTitle="Book" target={target} theme={theme} onClose={onClose} />);
  return { ...utils, onClose };
}

const bg = (word: string) => {
  const style = [screen.getByText(word).props.style].flat();
  return style.find((s) => s && 'backgroundColor' in s)?.backgroundColor;
};

describe('selection sheet', () => {
  it('opens with the long-pressed word selected, and highlights only that word', () => {
    const { onClose } = open('b1', 'fox');
    expect(bg('fox')).toBe(SELECTED);
    expect(bg('quick')).toBeUndefined();
    fireEvent.press(screen.getByLabelText('Highlight yellow'));
    expect(highlights('b1')).toEqual([['fox', 'yellow']]);
    expect(onClose).toHaveBeenCalled();
  });

  it('extends the selection by tapping another word, and starts over by tapping inside it', () => {
    open('b2', 'fox');
    fireEvent.press(screen.getByText('over'));
    for (const w of ['fox', 'jumps', 'over']) expect(bg(w)).toBe(SELECTED);
    fireEvent.press(screen.getByText('jumps'));
    expect(bg('jumps')).toBe(SELECTED);
    expect(bg('fox')).toBeUndefined();
    fireEvent.press(screen.getByLabelText('Highlight green'));
    expect(highlights('b2')).toEqual([['jumps', 'green']]);
  });

  it('a single word can be highlighted inside an already highlighted paragraph', () => {
    // First the whole paragraph in yellow...
    const first = open('b3');
    fireEvent.press(screen.getByLabelText('Highlight yellow'));
    expect(highlights('b3')).toEqual([[TEXT, 'yellow']]);
    first.unmount();
    // ...then long-press "fox" and make just that word blue.
    open('b3', 'fox');
    expect(bg('fox')).toBe(SELECTED);
    fireEvent.press(screen.getByLabelText('Highlight blue'));
    expect(highlights('b3')).toEqual([
      ['The quick brown ', 'yellow'],
      ['fox', 'blue'],
      [' jumps over the lazy dog', 'yellow'],
    ]);
  });

  it('"Remove" clears only the selected words', () => {
    const first = open('b4');
    fireEvent.press(screen.getByLabelText('Highlight pink'));
    first.unmount();
    open('b4', 'lazy');
    fireEvent.press(screen.getByLabelText('Remove highlight'));
    expect(highlights('b4')).toEqual([
      ['The quick brown fox jumps over the ', 'pink'],
      [' dog', 'pink'],
    ]);
  });

  it('"Select highlight" and "Whole paragraph" change the selection', () => {
    const first = open('b5', 'brown');
    fireEvent.press(screen.getByText('fox'));
    fireEvent.press(screen.getByLabelText('Highlight yellow')); // "brown fox"
    first.unmount();
    open('b5', 'fox');
    act(() => fireEvent.press(screen.getByText('Select highlight')));
    expect(bg('brown')).toBe(SELECTED);
    fireEvent.press(screen.getByText('Whole paragraph'));
    expect(bg('The')).toBeUndefined(); // whole paragraph: no word marked
    expect(screen.getByText(/Whole paragraph selected/)).toBeTruthy();
  });
});
