/// <reference types="jest" />
// Text selected on the page and what can be done with it (see useSelection),
// and definitions and translations shown in the app.

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { Alert, Share } from 'react-native';
import { addHighlight, getAnnotations } from '@/lib/annotations';
import { THEMES } from '@/lib/settings';
import type { LookupKind } from '@/reader/LookupCard';
import { LookupSheet } from '@/reader/LookupSheet';
import { selectionText } from '@/reader/selection';
import { useSelection } from '@/reader/useSelection';
import * as dialogs from '@/ui/dialogs';

const TEXT = 'The quick brown fox jumps over the lazy dog';
const theme = THEMES.light;
const textOf = (b: number) => (b === 0 ? TEXT : null);
const at = (word: string) => ({ b: 0, o: TEXT.indexOf(word) + 1 });
const highlights = (book: string) => getAnnotations(book).highlights.map((h) => [h.text, h.color]);

/** The selection hook for a one-paragraph book. */
async function selecting(book: string) {
  const hook = await renderHook(() => useSelection({ bookId: book, bookTitle: 'Book', textOf, chapterOf: () => undefined, color: 'yellow' }));
  const run = (f: (s: typeof hook.result.current) => void) => act(async () => f(hook.result.current));
  return { get: () => hook.result.current, run };
}

describe('selected text', () => {
  it('a long press selects the word; a colour highlights just it', async () => {
    const { get, run } = await selecting('s1');
    await run((s) => s.selectAt(at('fox'), false));
    expect(selectionText(get().sel!, textOf)).toBe('fox');
    await run((s) => s.highlight('green'));
    expect(highlights('s1')).toEqual([['fox', 'green']]);
    expect(get().sel).toBeNull(); // done with it
  });

  it('a word inside a highlighted paragraph can get its own colour', async () => {
    addHighlight('s2', { b: 0, s: 0, e: TEXT.length, color: 'yellow', text: TEXT });
    const { run } = await selecting('s2');
    await run((s) => s.selectAt(at('fox'), false));
    await run((s) => s.highlight('blue'));
    expect(highlights('s2')).toEqual([
      ['The quick brown', 'yellow'],
      ['fox', 'blue'],
      ['jumps over the lazy dog', 'yellow'],
    ]);
  });

  it('with the highlight tool, tapping a highlight selects all of it; a colour changes it', async () => {
    addHighlight('s3', { b: 0, s: 4, e: 15, color: 'yellow', text: 'quick brown' });
    const { get, run } = await selecting('s3');
    await run((s) => s.selectAt(at('brown'), true));
    expect(selectionText(get().sel!, textOf)).toBe('quick brown');
    expect(get().exact).toBeTruthy();
    await run((s) => s.highlight('pink'));
    expect(highlights('s3')).toEqual([['quick brown', 'pink']]);
  });

  it('Remove clears only the selected words; a note goes only with its whole highlight, after asking', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    addHighlight('s4', { b: 0, s: 0, e: TEXT.length, color: 'pink', text: TEXT, note: 'Aesop?' });
    const { run } = await selecting('s4');
    await run((s) => s.selectAt(at('lazy'), false));
    await run((s) => s.remove());
    expect(alert).not.toHaveBeenCalled(); // trimmed, the note stays with what's left
    expect(highlights('s4')).toEqual([
      ['The quick brown fox jumps over the', 'pink'],
      ['dog', 'pink'],
    ]);
    // The part with the note, whole: asks first.
    await run((s) => s.selectAt(at('quick'), true));
    await run((s) => s.remove());
    expect(alert.mock.calls[0][0]).toBe('Delete highlight and its note?');
    expect(getAnnotations('s4').highlights).toHaveLength(2);
    alert.mockRestore();
  });

  it('a note on new text highlights it with the note', async () => {
    const prompt = jest.spyOn(dialogs, 'showPrompt').mockImplementation((_t, o) => o.onSubmit('Remember this'));
    const { run } = await selecting('s5');
    await run((s) => s.selectAt(at('fox'), false));
    await run((s) => s.note());
    expect(getAnnotations('s5').highlights).toMatchObject([{ text: 'fox', color: 'yellow', note: 'Remember this' }]);
    prompt.mockRestore();
  });

  it('copy and share take the selected text', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction', activityType: undefined });
    const copy = jest.spyOn(Clipboard, 'setStringAsync');
    const { get, run } = await selecting('s6');
    await run((s) => s.selectAt(at('fox'), false));
    await run((s) => s.copy());
    expect(copy).toHaveBeenCalledWith('fox');
    await run((s) => s.selectAt(at('dog'), false));
    await run((s) => s.share());
    expect(share).toHaveBeenCalledWith({ message: '“dog”\n— Book' });
    expect(get().sel).toBeNull();
  });

  it('look up and translate show the selected text in the app', async () => {
    const { get, run } = await selecting('s7');
    await run((s) => s.selectAt(at('fox'), false));
    expect(get().oneWord).toBe(true);
    await run((s) => s.show('translate'));
    expect(get().lookup).toEqual({ kind: 'translate', text: 'fox' });
  });
});

/** The look-up sheet as the reader shows it: the kind can be switched, Close closes it. */
function LookupHarness({ kind, text }: { kind: LookupKind; text: string }) {
  const [lookup, setLookup] = useState<{ kind: LookupKind; text: string } | null>({ kind, text });
  return <LookupSheet lookup={lookup} theme={theme} onChange={setLookup} />;
}
const open = (kind: LookupKind, text: string) => render(<LookupHarness kind={kind} text={text} />);

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
    await open('define', 'fox');
    expect(await screen.findByText('A wild dog-like animal.')).toBeTruthy();
    expect(screen.getByText('Dictionary')).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toContain('/page/definition/fox');
    await fireEvent.press(screen.getByLabelText('Close dictionary'));
    expect(screen.queryByText('Dictionary')).toBeNull();
  });

  it('Translate shows the translation, and the chosen language is remembered', async () => {
    fetchMock.mockImplementation((url: string) =>
      json([[[url.includes('tl=tr') ? 'tilki' : 'лиса', 'fox', null, null, 3]], null, 'en']),
    );
    await open('translate', 'fox');
    expect(await screen.findByText('лиса')).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toContain('tl=en'); // nothing chosen yet: the phone's language
    await fireEvent.press(screen.getByLabelText('Translate into Türkçe'));
    expect(await screen.findByText('tilki')).toBeTruthy();
    // Next time it goes straight to Turkish.
    const { unmount } = screen;
    await unmount();
    fetchMock.mockClear();
    await open('translate', 'fox');
    expect(await screen.findByText('tilki')).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toContain('tl=tr');
  });

  it('offline: says so and offers to try again', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Network request failed')));
    await open('translate', 'fox');
    expect(await screen.findByText(/Couldn’t translate right now/)).toBeTruthy();
    fetchMock.mockImplementation(() => json([[['tilki', 'fox']], null, 'en']));
    await fireEvent.press(screen.getByLabelText('Try again'));
    expect(await screen.findByText('tilki')).toBeTruthy();
  });

  it('a word no dictionary knows offers a translation instead', async () => {
    fetchMock.mockImplementation(() => json(null, 404));
    await open('define', 'fox');
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
    await open('translate', 'fox');
    expect(await screen.findByText('tilki')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Show definition'));
    expect(await screen.findByText('A small wild canine.')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Show translation'));
    expect(await screen.findByText('tilki')).toBeTruthy();
  });

  it('a service error is not reported as a missing connection', async () => {
    fetchMock.mockImplementation(() => json({}, 429));
    await open('translate', 'fox');
    expect(await screen.findByText(/service didn’t answer/)).toBeTruthy();
  });
});
