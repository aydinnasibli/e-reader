/// <reference types="jest" />
// The highlights & notes screen and the book details screen.

import { fireEvent, render, screen } from '@testing-library/react-native';
import { addHighlight } from '@/lib/annotations';
import NotesScreen from '@/app/notes';
import BookDetails from '@/app/book/[id]';

const mockBooks = [
  { id: 'a', title: 'Moby-Dick', author: 'Herman Melville', fileName: 'moby.epub', format: 'epub', size: 1_300_000, addedAt: 1, openedAt: 20, status: 'ready', progress: 1, percent: 0.25 },
  { id: 'b', title: 'Anna Karenina', author: 'Leo Tolstoy', fileName: 'anna.fb2', format: 'fb2', size: 2_400_000, addedAt: 2, openedAt: 10, status: 'ready', progress: 1, percent: 0.5, titleEdited: true },
];
const mockPush = jest.fn();
const mockShare = jest.fn();
const mockRename = jest.fn();
const mockRestore = jest.fn();
let mockParams: Record<string, string> = {};

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn() },
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@/lib/library', () => ({
  useLibrary: () => mockBooks,
  useBook: (id: string) => mockBooks.find((b) => b.id === id),
  loadManifest: () => ({ totalChars: 600_000, lang: 'en' }),
  renameBook: (...a: unknown[]) => mockRename(...a),
  restoreBookTitle: (...a: unknown[]) => mockRestore(...a),
  deleteBook: jest.fn(),
  coverUri: () => undefined,
}));
jest.mock('@/lib/shareText', () => ({ shareTextFile: (...a: unknown[]) => mockShare(...a) }));
// Prompts answer straight away in tests.
jest.mock('@/ui/dialogs', () => ({
  showActions: jest.fn(),
  showPrompt: (title: string, o: { onSubmit(t: string): void }) => o.onSubmit(title === 'Title' ? 'Moby Dick, or The Whale' : 'H. Melville'),
}));

beforeAll(async () => {
  addHighlight('a', { b: 3, s: 0, e: 16, color: 'yellow', text: 'Call me Ishmael.', chapter: 'Loomings' });
  addHighlight('a', { b: 9, s: 4, e: 30, color: 'green', text: 'a damp, drizzly November', note: 'Mood.', chapter: 'Loomings' });
  addHighlight('b', { b: 1, s: 0, e: 44, color: 'pink', text: 'Happy families are all alike', chapter: 'Part One' });
});

describe('highlights & notes', () => {
  it('lists highlights by book, searches, filters notes, opens and exports', async () => {
    await render(<NotesScreen />);
    expect(screen.getByText('Moby-Dick')).toBeTruthy();
    expect(screen.getByText('2 highlights')).toBeTruthy();
    expect(screen.getByText('Anna Karenina')).toBeTruthy();

    await fireEvent.changeText(screen.getByPlaceholderText('Search highlights and notes'), 'november');
    expect(screen.queryByText('Call me Ishmael.')).toBeNull();
    expect(screen.getByText('a damp, drizzly November')).toBeTruthy();
    await fireEvent.changeText(screen.getByPlaceholderText('Search highlights and notes'), '');

    await fireEvent.press(screen.getByText('With notes'));
    expect(screen.queryByText('Anna Karenina')).toBeNull();
    expect(screen.getByText('a damp, drizzly November')).toBeTruthy();
    await fireEvent.press(screen.getByText('With notes'));

    await fireEvent.press(screen.getByText('Call me Ishmael.'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/reader/[id]', params: { id: 'a', b: '3', o: '0' } });

    await fireEvent.press(screen.getByLabelText('Export Moby-Dick'));
    const [name, md] = mockShare.mock.calls[0];
    expect(name).toBe('Moby-Dick.md');
    expect(md).toContain('> Call me Ishmael.');
    expect(md).toContain('**Note:** Mood.');
    expect(md).not.toContain('Happy families');
  });
});

describe('book details', () => {
  it('shows the book and reading facts, and edits the title and author', async () => {
    mockParams = { id: 'a' };
    await render(<BookDetails />);
    expect(screen.getAllByText('Moby-Dick').length).toBeGreaterThan(0); // heading (and the placeholder cover)
    expect(screen.getByText('EPUB')).toBeTruthy();
    expect(screen.getByText('1.2 MB')).toBeTruthy();
    expect(screen.getByText('25%')).toBeTruthy();
    expect(screen.getAllByText('2').length).toBeGreaterThan(0); // highlights
    await fireEvent.press(screen.getByLabelText('Edit title'));
    expect(mockRename).toHaveBeenCalledWith('a', { title: 'Moby Dick, or The Whale' });
    await fireEvent.press(screen.getByLabelText('Edit author'));
    expect(mockRename).toHaveBeenCalledWith('a', { author: 'H. Melville' });
    expect(screen.queryByText('Use the book’s own title')).toBeNull();
  });

  it('an edited title can go back to the book’s own', async () => {
    mockParams = { id: 'b' };
    await render(<BookDetails />);
    await fireEvent.press(screen.getByText('Use the book’s own title'));
    expect(mockRestore).toHaveBeenCalledWith('b');
  });
});
