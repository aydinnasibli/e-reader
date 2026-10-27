/// <reference types="jest" />
// A generated cover (a book without a picture of its own). A title made of
// long words joined by "-", "." or "_" (from a file name) breaks after those
// marks and gets smaller until its longest word fits, instead of being split
// anywhere ("istanbul-125 / 4"). And the cover isn't read out: the title is
// shown beside it.

import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { Cover } from '@/ui/Cover';

jest.mock('@/lib/library', () => ({ coverUri: () => undefined }));

const book = (title: string, author = '') => ({ id: title, title, author, fileName: 'x.txt', size: 1, addedAt: 0, openedAt: 0, status: 'ready', progress: 1 }) as never;
const titleText = (start: RegExp) => screen.getByText(start, { includeHiddenElements: true });

it('a file-name title may break after "-", "." and "_", and its longest word fits on a line', async () => {
  // A grid cell on a 360-point phone, the "Continue reading" card, a list row.
  for (const width of [99, 78, 50]) {
    const view = await render(<Cover book={book('big-english-60mb.v2_final')} width={width} />);
    const text = titleText(/^big-/);
    expect(text.props.children).toBe('big-​english-​60mb.​v2_​final');
    // About 0.6 em a bold letter; "english-" is the longest word left.
    const { fontSize } = StyleSheet.flatten(text.props.style);
    const room = width - 2 * (width < 70 ? 5 : 10) - 4;
    expect([width, 'english-'.length * fontSize * 0.6 <= room]).toEqual([width, true]);
    await view.unmount();
  }
});

it('a long ordinary word fits the "Continue reading" card\'s cover too', async () => {
  await render(<Cover book={book('Çınar Gölgesi (Simülatör)')} width={78} />);
  const { fontSize } = StyleSheet.flatten(titleText(/^Çınar/).props.style);
  expect('(Simülatör)'.length * fontSize * 0.6).toBeLessThanOrEqual(78 - 2 * 10 - 4);
});

it('a title of ordinary words keeps its size', async () => {
  await render(<Cover book={book('Anna Karenina')} width={99} />);
  expect(StyleSheet.flatten(titleText(/^Anna/).props.style).fontSize).toBe(14);
});

it('is a picture of the title, not read out', async () => {
  await render(<Cover book={book('Anna Karenina', 'Leo Tolstoy')} width={110} />);
  expect(screen.queryByText('Anna Karenina')).toBeNull();
  expect(screen.queryByText('Leo Tolstoy')).toBeNull();
  expect(screen.getByText('Anna Karenina', { includeHiddenElements: true })).toBeTruthy();
});
