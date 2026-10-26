/// <reference types="jest" />
// The highlights & notes screen and the book details screen.

import { fireEvent, render, screen } from '@testing-library/react-native';
import { addHighlight } from '@/lib/annotations';
import NotesScreen from '@/app/notes';
import BookDetails from '@/app/book/[id]';

const mockBooks: Record<string, unknown>[] = [
  { id: 'a', title: 'Moby-Dick', author: 'Herman Melville', fileName: 'moby.epub', format: 'epub', size: 1_300_000, addedAt: 1, openedAt: 20, status: 'ready', progress: 1, percent: 0.25 },
  { id: 'b', title: 'Anna Karenina', author: 'Leo Tolstoy', fileName: 'anna.fb2', format: 'fb2', size: 2_400_000, addedAt: 2, openedAt: 10, status: 'ready', progress: 1, percent: 0.5, titleEdited: true },
  { id: 'c', title: 'İstanbul Hatırası', author: 'Ahmet Ümit', fileName: 'ist.epub', format: 'epub', size: 900_000, addedAt: 3, openedAt: 5, status: 'ready', progress: 1, percent: 0.1, lang: 'tr' },
];
const mockPush = jest.fn();
const mockShare = jest.fn();
const mockRename = jest.fn();
const mockRestore = jest.fn();
const mockSetLanguage = jest.fn();
const mockActions = jest.fn();
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
  setBookLanguage: (...a: unknown[]) => mockSetLanguage(...a),
  deleteBook: jest.fn(),
  coverUri: () => undefined,
}));
jest.mock('@/lib/shareText', () => ({ shareTextFile: (...a: unknown[]) => mockShare(...a) }));
// Prompts answer straight away in tests.
jest.mock('@/ui/dialogs', () => ({
  showActions: (...a: unknown[]) => mockActions(...a),
  showPrompt: (title: string, o: { onSubmit(t: string): void }) => o.onSubmit(title === 'Title' ? 'Moby Dick, or The Whale' : 'H. Melville'),
}));

beforeAll(async () => {
  addHighlight('a', { b: 3, s: 0, e: 16, color: 'yellow', text: 'Call me Ishmael.', chapter: 'Loomings' });
  addHighlight('a', { b: 9, s: 4, e: 30, color: 'green', text: 'a damp, drizzly November', note: 'Mood.', chapter: 'Loomings' });
  addHighlight('b', { b: 1, s: 0, e: 44, color: 'pink', text: 'Happy families are all alike', chapter: 'Part One' });
  addHighlight('c', { b: 2, s: 0, e: 21, color: 'blue', text: "İstanbul'da bir sabah", note: 'Kırmızı bir gün', chapter: 'Birinci Bölüm' });
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

  it('search ignores case, accents and the Turkish I/ı/İ/i, on a phone set to English', async () => {
    // A phone whose language is English: lower-casing without a locale uses it.
    const lower = String.prototype.toLocaleLowerCase;
    const spy = jest.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (this: string, locales?: Intl.LocalesArgument) {
      return lower.call(this, locales ?? 'en-US');
    });
    try {
      await render(<NotesScreen />);
      const box = screen.getByPlaceholderText('Search highlights and notes');
      const quote = "İstanbul'da bir sabah";
      for (const q of ['istanbul', 'ISTANBUL', 'kirmizi', 'birinci bolum', 'HATIRASI']) {
        await fireEvent.changeText(box, q); // the text, the note, the chapter, the book
        expect([q, !!screen.queryByText(quote)]).toEqual([q, true]);
        expect(screen.queryByText('Call me Ishmael.')).toBeNull();
      }
    } finally {
      spy.mockRestore();
    }
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

  it('shows the language found in the book, and it can be set by hand or put back to automatic', async () => {
    mockParams = { id: 'a' };
    await render(<BookDetails />);
    expect(screen.getByText('English (automatic)')).toBeTruthy();
    mockActions.mockClear();
    await fireEvent.press(screen.getByLabelText('Book language'));
    const [title, actions] = mockActions.mock.calls[0] as [string, { label: string; checked?: boolean; onPress(): void }[]];
    expect(title).toBe('Book language');
    expect(actions[0]).toMatchObject({ label: 'Automatic (English)', checked: true });
    expect(actions.map((a) => a.label)).toEqual(expect.arrayContaining(['Turkish', 'English', 'Azerbaijani', 'Russian', 'German', 'French', 'Spanish']));
    actions.find((a) => a.label === 'Turkish')!.onPress();
    expect(mockSetLanguage).toHaveBeenLastCalledWith('a', 'tr');
    actions[0].onPress();
    expect(mockSetLanguage).toHaveBeenLastCalledWith('a', undefined);
  });

  it('a language set by hand shows as chosen', async () => {
    mockParams = { id: 'c' };
    await render(<BookDetails />);
    expect(screen.getByText('Turkish')).toBeTruthy();
    mockActions.mockClear();
    await fireEvent.press(screen.getByLabelText('Book language'));
    const actions = mockActions.mock.calls[0][1] as { label: string; checked?: boolean }[];
    expect(actions.filter((a) => a.checked).map((a) => a.label)).toEqual(['Turkish']);
  });
});
