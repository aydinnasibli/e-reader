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

async function open(book: string, pressed?: string) {
  const onClose = jest.fn();
  const target = { b: 0, block, at: pressed ? at(pressed) : undefined };
  const utils = await render(<SelectionSheet bookId={book} bookTitle="Book" target={target} theme={theme} onClose={onClose} />);
  return { ...utils, onClose };
}

const bg = (word: string) => {
  const style = [screen.getByText(word).props.style].flat();
  return style.find((s) => s && 'backgroundColor' in s)?.backgroundColor;
};

describe('selection sheet', () => {
  it('opens with the long-pressed word selected, and highlights only that word', async () => {
    const { onClose } = await open('b1', 'fox');
    expect(bg('fox')).toBe(SELECTED);
    expect(bg('quick')).toBeUndefined();
    await fireEvent.press(screen.getByLabelText('Highlight yellow'));
    expect(highlights('b1')).toEqual([['fox', 'yellow']]);
    expect(onClose).toHaveBeenCalled();
  });

  it('extends the selection by tapping another word, and starts over by tapping inside it', async () => {
    await open('b2', 'fox');
    await fireEvent.press(screen.getByText('over'));
    for (const w of ['fox', 'jumps', 'over']) expect(bg(w)).toBe(SELECTED);
    await fireEvent.press(screen.getByText('jumps'));
    expect(bg('jumps')).toBe(SELECTED);
    expect(bg('fox')).toBeUndefined();
    await fireEvent.press(screen.getByLabelText('Highlight green'));
    expect(highlights('b2')).toEqual([['jumps', 'green']]);
  });

  it('a single word can be highlighted inside an already highlighted paragraph', async () => {
    // First the whole paragraph in yellow...
    const first = await open('b3');
    await fireEvent.press(screen.getByLabelText('Highlight yellow'));
    expect(highlights('b3')).toEqual([[TEXT, 'yellow']]);
    await first.unmount();
    // ...then long-press "fox" and make just that word blue.
    await open('b3', 'fox');
    expect(bg('fox')).toBe(SELECTED);
    await fireEvent.press(screen.getByLabelText('Highlight blue'));
    expect(highlights('b3')).toEqual([
      ['The quick brown ', 'yellow'],
      ['fox', 'blue'],
      [' jumps over the lazy dog', 'yellow'],
    ]);
  });

  it('"Remove" clears only the selected words', async () => {
    const first = await open('b4');
    await fireEvent.press(screen.getByLabelText('Highlight pink'));
    await first.unmount();
    await open('b4', 'lazy');
    await fireEvent.press(screen.getByLabelText('Remove highlight'));
    expect(highlights('b4')).toEqual([
      ['The quick brown fox jumps over the ', 'pink'],
      [' dog', 'pink'],
    ]);
  });

  it('"Select highlight" and "Whole paragraph" change the selection', async () => {
    const first = await open('b5', 'brown');
    await fireEvent.press(screen.getByText('fox'));
    await fireEvent.press(screen.getByLabelText('Highlight yellow')); // "brown fox"
    await first.unmount();
    await open('b5', 'fox');
    await act(() => fireEvent.press(screen.getByText('Select highlight')));
    expect(bg('brown')).toBe(SELECTED);
    await fireEvent.press(screen.getByText('Whole paragraph'));
    expect(bg('The')).toBeUndefined(); // whole paragraph: no word marked
    expect(screen.getByText(/Whole paragraph selected/)).toBeTruthy();
  });
});

describe('look up and translate stay in the app', () => {
  const json = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)) });
  const fetchMock = jest.fn();
  beforeAll(async () => {
    (global as { fetch: unknown }).fetch = fetchMock;
  });
  beforeEach(() => fetchMock.mockReset());

  it('Look up shows the definition in the sheet', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('wiktionary')
        ? json({ en: [{ partOfSpeech: 'Noun', language: 'English', definitions: [{ definition: 'A wild <a href="/wiki/dog">dog</a>-like animal.' }] }] })
        : json(null, 500),
    );
    await open('c1', 'fox');
    await fireEvent.press(screen.getByLabelText('Look up'));
    expect(await screen.findByText('A wild dog-like animal.')).toBeTruthy();
    expect(screen.getByText('Dictionary')).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toContain('/page/definition/fox');
    // Back to the selection, still selected.
    await fireEvent.press(screen.getByLabelText('Back to selection'));
    expect(bg('fox')).toBe(SELECTED);
  });

  it('Translate shows the translation, and the chosen language is remembered', async () => {
    fetchMock.mockImplementation((url: string) =>
      json([[[url.includes('tl=tr') ? 'tilki' : 'лиса', 'fox', null, null, 3]], null, 'en']),
    );
    await open('c2', 'fox');
    await fireEvent.press(screen.getByLabelText('Translate'));
    expect(await screen.findByText('лиса')).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toContain('tl=en'); // nothing chosen yet: the phone's language
    await fireEvent.press(screen.getByLabelText('Translate into Türkçe'));
    expect(await screen.findByText('tilki')).toBeTruthy();
    // Next time it goes straight to Turkish.
    const { unmount } = screen;
    await unmount();
    fetchMock.mockClear();
    await open('c2', 'fox');
    await fireEvent.press(screen.getByLabelText('Translate'));
    expect(await screen.findByText('tilki')).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toContain('tl=tr');
  });

  it('offline: says so and offers to try again', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Network request failed')));
    await open('c3', 'fox');
    await fireEvent.press(screen.getByLabelText('Translate'));
    expect(await screen.findByText(/Couldn’t translate right now/)).toBeTruthy();
    fetchMock.mockImplementation(() => json([[['tilki', 'fox']], null, 'en']));
    await fireEvent.press(screen.getByLabelText('Try again'));
    expect(await screen.findByText('tilki')).toBeTruthy();
  });

  it('a word no dictionary knows offers a translation instead', async () => {
    fetchMock.mockImplementation(() => json(null, 404));
    await open('c4', 'fox');
    await fireEvent.press(screen.getByLabelText('Look up'));
    expect(await screen.findByText(/No dictionary entry/)).toBeTruthy();
    // "Translate instead" switches over without reading the empty definition as a translation.
    fetchMock.mockImplementation(() => json([[['tilki', 'fox']], null, 'en']));
    await fireEvent.press(screen.getByLabelText('Translate instead'));
    expect(await screen.findByText('tilki')).toBeTruthy();
  });

  it('switching from a translation to the definition and back', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('wiktionary')
        ? json({ en: [{ partOfSpeech: 'Noun', language: 'English', definitions: [{ definition: 'A small wild canine.' }] }] })
        : json([[['tilki', 'fox']], null, 'en']),
    );
    await open('c5', 'fox');
    await fireEvent.press(screen.getByLabelText('Translate'));
    expect(await screen.findByText('tilki')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Show definition'));
    expect(await screen.findByText('A small wild canine.')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Show translation'));
    expect(await screen.findByText('tilki')).toBeTruthy();
  });

  it('a service error is not reported as a missing connection', async () => {
    fetchMock.mockImplementation(() => json({}, 429));
    await open('c6', 'fox');
    await fireEvent.press(screen.getByLabelText('Translate'));
    expect(await screen.findByText(/service didn’t answer/)).toBeTruthy();
  });
});
