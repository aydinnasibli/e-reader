/// <reference types="jest" />
// Text selected on the page and what can be done with it (see useSelection),
// and definitions and translations shown in the app.

import { act, fireEvent, render, renderHook } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { Alert, Share, StyleSheet } from 'react-native';
import { addHighlight, getAnnotations } from '@/lib/annotations';
import { THEMES } from '@/lib/settings';
import type { LookupKind } from '@/reader/LookupCard';
import { LookupSheet } from '@/reader/LookupSheet';
import { SelectionMenu } from '@/reader/SelectionMenu';
import { nearestWord, useSelection } from '@/reader/useSelection';
import * as dialogs from '@/ui/dialogs';

const TEXT = 'The quick brown fox jumps over the lazy dog';
const theme = THEMES.light;
const textOf = (b: number) => (b === 0 ? TEXT : null);
const at = (word: string) => ({ b: 0, o: TEXT.indexOf(word) + 1 });
const highlights = (book: string) => getAnnotations(book).highlights.map((h) => [h.text, h.color]);

// The first render in a file pays for loading React Native's renderer, the sheet and its modal: done
// here, with time to spare, so no one test runs past its limit on a busy machine.
beforeAll(async () => {
  const warm = await render(<LookupSheet lookup={null} theme={theme} onChange={() => {}} />);
  await warm.unmount();
  const hook = await renderHook(() => useSelection({ bookId: 'warm', bookTitle: 'Book', textOf, chapterOf: () => undefined, color: 'yellow' }));
  await hook.unmount();
}, 60000);

/** The selection hook for a one-paragraph book. */
async function selecting(book: string) {
  const hook = await renderHook(() => useSelection({ bookId: book, bookTitle: 'Book', textOf, chapterOf: () => undefined, color: 'yellow' }));
  const run = (f: (s: typeof hook.result.current) => void) => act(async () => f(hook.result.current));
  return { get: () => hook.result.current, run };
}

describe('the highlight tool: a marker pen', () => {
  let alert: jest.SpyInstance;
  beforeEach(() => (alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})));
  afterEach(() => alert.mockRestore());
  const word = (w: string) => ({ b: 0, o: TEXT.indexOf(w), e: TEXT.indexOf(w) + w.length });

  it('a tap highlights the word, in the colour picked; a tap on it takes it away', async () => {
    const { get, run } = await selecting('m1');
    await run((s) => s.markTap(at('fox')));
    expect(highlights('m1')).toEqual([['fox', 'yellow']]);
    expect(get().sel).toBeNull(); // nothing selected: no handles, no menu
    expect(get().made.map((h) => h.text)).toEqual(['fox']);
    await run((s) => s.markTap(at('fox')));
    expect(highlights('m1')).toEqual([]);
  });

  it('a drag highlights what it covers, drawn as it goes; one starting on a highlight takes highlighting away', async () => {
    const { get, run } = await selecting('m2');
    await run((s) => s.markDrag(at('quick'), at('jumps'), false));
    expect(get().stroke).toEqual({ ranges: [{ b: 0, s: word('quick').o, e: word('jumps').e }], erase: false });
    expect(highlights('m2')).toEqual([]); // not until the finger lifts
    await run((s) => s.markDrag(at('quick'), at('jumps'), true));
    expect(highlights('m2')).toEqual([['quick brown fox jumps', 'yellow']]);
    expect(get().stroke).toBeNull();

    // Over part of it again: that part is taken away.
    await run((s) => s.markDrag(at('brown'), at('fox'), false));
    expect(get().stroke?.erase).toBe(true);
    await run((s) => s.markDrag(at('brown'), at('fox'), true));
    expect(highlights('m2')).toEqual([
      ['quick', 'yellow'],
      ['jumps', 'yellow'],
    ]);
  });

  it('a cancelled drag changes nothing', async () => {
    const { get, run } = await selecting('m3');
    await run((s) => s.markDrag(at('lazy'), at('dog'), false));
    await run((s) => s.markDrag(null, null, true));
    expect(get().stroke).toBeNull();
    expect(highlights('m3')).toEqual([]);
  });

  it('Note, Copy and Remove act on the highlight just made', async () => {
    const prompt = jest.spyOn(dialogs, 'showPrompt').mockImplementation((_t, o) => o.onSubmit('Remember this'));
    const copy = jest.spyOn(Clipboard, 'setStringAsync');
    const { get, run } = await selecting('m4');
    await run((s) => s.markDrag(at('lazy'), at('dog'), true));
    await run((s) => s.noteMade());
    expect(getAnnotations('m4').highlights).toMatchObject([{ text: 'lazy dog', note: 'Remember this' }]);
    await run((s) => s.copyMade());
    expect(copy).toHaveBeenCalledWith('lazy dog');
    await run((s) => s.removeMade());
    expect(alert).toHaveBeenCalledWith('Delete highlight and its note?', undefined, expect.anything()); // it has a note: asks first
    expect(get().made).toHaveLength(1);
    prompt.mockRestore();
  });

  it('a tap on a highlight takes all of it away, not just the word tapped', async () => {
    const { run } = await selecting('m6');
    await run((s) => s.markDrag(at('quick'), at('jumps'), true));
    await run((s) => s.markTap(at('fox')));
    expect(highlights('m6')).toEqual([]);
    expect(alert).not.toHaveBeenCalled();
  });

  it('highlighting over all of a highlight with a note asks first: Cancel adds nothing, Delete highlights over it', async () => {
    const fox = { b: 0, s: TEXT.indexOf('fox'), e: TEXT.indexOf('fox') + 3 };
    addHighlight('m7', { ...fox, color: 'pink', text: 'fox', note: 'Clever' });
    const { run } = await selecting('m7');
    // A drag over it, from a word that isn't highlighted.
    await run((s) => s.markDrag(at('quick'), at('jumps'), true));
    expect(alert).toHaveBeenCalledWith('Highlight over a note?', expect.any(String), expect.anything());
    expect(highlights('m7')).toEqual([['fox', 'pink']]); // nothing until it's answered (Cancel: nothing at all)
    const buttons = alert.mock.calls[0][2] as { text: string; onPress?: () => void }[];
    await act(async () => buttons.find((b) => b.text === 'Highlight')!.onPress!());
    expect(highlights('m7')).toEqual([['quick brown fox jumps', 'yellow']]);
    // A tap on a word that holds a highlight with a note (in part of it) asks too.
    addHighlight('m8', { b: 0, s: TEXT.indexOf('row'), e: TEXT.indexOf('row') + 3, color: 'pink', text: 'row', note: 'Rowing' });
    const tapping = await selecting('m8');
    alert.mockClear();
    await tapping.run((s) => s.markTap({ b: 0, o: TEXT.indexOf('brown') }));
    expect(alert).toHaveBeenCalledWith('Highlight over a note?', expect.any(String), expect.anything());
    expect(highlights('m8')).toEqual([['row', 'pink']]);
    // Without a note in the way, nothing is asked.
    alert.mockClear();
    const free = await selecting('m9');
    await free.run((s) => s.markDrag(at('quick'), at('jumps'), true));
    expect(alert).not.toHaveBeenCalled();
    expect(highlights('m9')).toEqual([['quick brown fox jumps', 'yellow']]);
  });

  it('taking away part of a highlight keeps its note; taking away all of a highlight with a note asks first', async () => {
    addHighlight('m5', { b: 0, s: 0, e: TEXT.length, color: 'pink', text: TEXT, note: 'Aesop?' });
    const { run } = await selecting('m5');
    await run((s) => s.markDrag(at('lazy'), at('lazy'), true));
    expect(alert).not.toHaveBeenCalled();
    expect(highlights('m5')).toEqual([
      ['The quick brown fox jumps over the', 'pink'],
      ['dog', 'pink'],
    ]);
    await run((s) => s.markTap(at('quick')));
    expect(alert).toHaveBeenCalledWith('Delete highlight and its note?', undefined, expect.anything());
    expect(getAnnotations('m5').highlights).toHaveLength(2);
  });
});

describe('selected text (long press)', () => {
  /** What the page selected: characters [s, e) of the paragraph. */
  const range = (s: number, e: number) => ({ a: { b: 0, o: s }, z: { b: 0, o: e - 1 } });
  const word = (w: string) => range(TEXT.indexOf(w), TEXT.indexOf(w) + w.length);

  it('copy and share take exactly the characters selected', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction', activityType: undefined });
    const copy = jest.spyOn(Clipboard, 'setStringAsync');
    const { get, run } = await selecting('s6');
    await run((s) => s.setSel(word('fox')));
    await run((s) => s.copy());
    expect(copy).toHaveBeenCalledWith('fox');
    // Part of a word, or words: what was selected, no more.
    await run((s) => s.setSel(range(TEXT.indexOf('uick'), TEXT.indexOf('bro') + 3)));
    await run((s) => s.copy());
    expect(copy).toHaveBeenLastCalledWith('uick bro');
    await run((s) => s.setSel(word('dog')));
    await run((s) => s.share());
    expect(share).toHaveBeenCalledWith({ message: '“dog”\n— Book' });
    expect(get().sel).toBeNull();
  });

  it('look up and translate show the whole words in the app', async () => {
    const { get, run } = await selecting('s7');
    await run((s) => s.setSel(range(TEXT.indexOf('ox'), TEXT.indexOf('ox') + 2)));
    expect(get().oneWord).toBe(true);
    await run((s) => s.show('define'));
    expect(get().lookup).toEqual({ kind: 'define', text: 'fox' });
    await run((s) => s.setSel(word('fox')));
    await run((s) => s.show('translate'));
    expect(get().lookup).toEqual({ kind: 'translate', text: 'fox' });
  });
});

/** The look-up sheet as the reader shows it: the kind can be switched, Close closes it. */
function LookupHarness({ kind, text }: { kind: LookupKind; text: string }) {
  const [lookup, setLookup] = useState<{ kind: LookupKind; text: string } | null>({ kind, text });
  return <LookupSheet lookup={lookup} theme={theme} onChange={setLookup} />;
}
/** The sheet open on `text`; its own queries (not the shared `screen`, which a test left half done could point elsewhere). */
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
    const view = await open('define', 'fox');
    expect(await view.findByText('A wild dog-like animal.')).toBeTruthy();
    expect(view.getByText('Dictionary')).toBeTruthy();
    // (The English meaning may be asked for alongside: whichever goes first.)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/page/definition/fox'))).toBe(true);
    await fireEvent.press(view.getByLabelText('Close dictionary'));
    expect(view.queryByText('Dictionary')).toBeNull();
  });

  it('Translate shows the translation, and the chosen language is remembered', async () => {
    fetchMock.mockImplementation((url: string) =>
      json([[[url.includes('tl=tr') ? 'tilki' : 'лиса', 'fox', null, null, 3]], null, 'en']),
    );
    const view = await open('translate', 'fox');
    expect(await view.findByText('лиса')).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toContain('tl=en'); // nothing chosen yet: the phone's language
    await fireEvent.press(view.getByLabelText('Translate into Türkçe'));
    expect(await view.findByText('tilki')).toBeTruthy();
    // Next time it goes straight to Turkish.
    await view.unmount();
    fetchMock.mockClear();
    const again = await open('translate', 'fox');
    expect(await again.findByText('tilki')).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toContain('tl=tr');
  });

  it('offline: says so and offers to try again', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Network request failed')));
    const view = await open('translate', 'fox');
    expect(await view.findByText(/Couldn’t translate right now/)).toBeTruthy();
    fetchMock.mockImplementation(() => json([[['tilki', 'fox']], null, 'en']));
    await fireEvent.press(view.getByLabelText('Try again'));
    expect(await view.findByText('tilki')).toBeTruthy();
  });

  it('a word no dictionary knows offers a translation instead', async () => {
    fetchMock.mockImplementation(() => json(null, 404));
    const view = await open('define', 'fox');
    expect(await view.findByText(/No dictionary entry/)).toBeTruthy();
    // "Translate instead" switches over without reading the empty definition as a translation.
    fetchMock.mockImplementation(() => json([[['tilki', 'fox']], null, 'en']));
    await fireEvent.press(view.getByLabelText('Translate instead'));
    expect(await view.findByText('tilki')).toBeTruthy();
  });

  it('switching from a translation to the definition and back', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('wiktionary')
        ? json({ en: [{ partOfSpeech: 'Noun', language: 'English', definitions: [{ definition: 'A small wild canine.' }] }] })
        : json([[['tilki', 'fox']], null, 'en']),
    );
    const view = await open('translate', 'fox');
    expect(await view.findByText('tilki')).toBeTruthy();
    await fireEvent.press(view.getByLabelText('Show definition'));
    expect(await view.findByText('A small wild canine.')).toBeTruthy();
    await fireEvent.press(view.getByLabelText('Show translation'));
    expect(await view.findByText('tilki')).toBeTruthy();
  });

  it('a service error is not reported as a missing connection', async () => {
    fetchMock.mockImplementation(() => json({}, 429));
    const view = await open('translate', 'fox');
    expect(await view.findByText(/service didn’t answer/)).toBeTruthy();
  });
});

describe('the menu over selected text', () => {
  const noop = () => {};
  const menu = (start: { x: number; y: number; h: number }, end: { x: number; y: number; h: number }) =>
    render(<SelectionMenu start={start} end={end} canLookUp onCopy={noop} onLookUp={noop} onTranslate={noop} onShare={noop} />);
  /** The menu box, laid out at 200 wide; its position. */
  const placed = async (view: Awaited<ReturnType<typeof menu>>) => {
    const box = view.container.queryAll((n) => typeof n.props.onLayout === 'function')[0];
    await fireEvent(box, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 44 } } });
    const flat = (n: { props: { style?: unknown } }) => Object.assign({}, ...[n.props.style].flat()) as Record<string, number>;
    // The full-width row (at the menu's height) and the menu in it (at its place along it).
    const row = view.container.queryAll((n) => n.props.pointerEvents === 'box-none')[0];
    const menuBox = view.container.queryAll((n) => typeof n.props.onLayout === 'function')[0];
    return { ...flat(row), ...flat(menuBox) };
  };

  it('sits over the middle of a one-line selection, above it', async () => {
    const st = await placed(await menu({ x: 150, y: 300, h: 24 }, { x: 250, y: 300, h: 24 }));
    expect(st.marginLeft).toBe(100); // centred on x 200
    expect(st.top).toBeLessThan(300);
    expect(st.opacity).toBe(1);
  });

  it('its items are full-size targets for the finger (44 points high: a hit area past the bar is not touched on Android)', async () => {
    const view = await menu({ x: 150, y: 300, h: 24 }, { x: 250, y: 300, h: 24 });
    const flat = (n: { props: { style?: unknown } }) => StyleSheet.flatten(n.props.style as never) ?? {};
    const bar = view.container.queryAll((n) => n.type === 'View' && flat(n).flexDirection === 'row' && flat(n).borderRadius === 10)[0];
    expect(flat(bar).height).toBeGreaterThanOrEqual(44);
    expect(view.getByLabelText('Copy').props.hitSlop).toBeUndefined();
  });

  it('stays on screen at the edge, and goes below the text near the top', async () => {
    const st = await placed(await menu({ x: 4, y: 10, h: 24 }, { x: 40, y: 10, h: 24 }));
    expect(st.marginLeft).toBeGreaterThanOrEqual(8);
    expect(st.top).toBeGreaterThan(10 + 24);
  });
});

it('a highlight-tool tap between two words takes the closer one', async () => {
  expect(nearestWord(TEXT, 3)).toBe(2); // the space after "The"
  expect(nearestWord('a     word', 5)).toBe(6);
  expect(nearestWord('   a', 0)).toBe(3);
  const { run } = await selecting('s8');
  await run((s) => s.markTap({ b: 0, o: TEXT.indexOf(' fox') }));
  expect(highlights('s8')).toEqual([['brown', 'yellow']]);
});
