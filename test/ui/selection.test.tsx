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
import { CharProbe } from '@/reader/CharProbe';
import { charWidth, resetWidths } from '@/reader/charWidths';
import { LookupSheet } from '@/reader/LookupSheet';
import { SelectionMenu } from '@/reader/SelectionMenu';
import { selectionText } from '@/reader/selection';
import { nearestWord, useSelection } from '@/reader/useSelection';
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

  it('taking away part of a highlight keeps its note; taking away all of a highlight with a note asks first', async () => {
    addHighlight('m5', { b: 0, s: 0, e: TEXT.length, color: 'pink', text: TEXT, note: 'Aesop?' });
    const { run } = await selecting('m5');
    await run((s) => s.markTap(at('lazy')));
    expect(alert).not.toHaveBeenCalled();
    expect(highlights('m5')).toEqual([
      ['The quick brown fox jumps over the', 'pink'],
      ['dog', 'pink'],
    ]);
    await run((s) => s.markDrag(at('The'), at('the'), true));
    expect(alert).toHaveBeenCalledWith('Delete highlight and its note?', undefined, expect.anything());
    expect(getAnnotations('m5').highlights).toHaveLength(2);
  });
});

describe('selected text (long press)', () => {
  it('copy and share take the selected text', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction', activityType: undefined });
    const copy = jest.spyOn(Clipboard, 'setStringAsync');
    const { get, run } = await selecting('s6');
    await run((s) => s.selectAt(at('fox')));
    await run((s) => s.copy());
    expect(copy).toHaveBeenCalledWith('fox');
    await run((s) => s.selectAt(at('dog')));
    await run((s) => s.share());
    expect(share).toHaveBeenCalledWith({ message: '“dog”\n— Book' });
    expect(get().sel).toBeNull();
  });

  it('look up and translate show the selected text in the app', async () => {
    const { get, run } = await selecting('s7');
    await run((s) => s.selectAt(at('fox')));
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

describe('the menu over selected text', () => {
  const noop = () => {};
  const menu = (start: { x: number; y: number; h: number }, end: { x: number; y: number; h: number }) =>
    render(<SelectionMenu start={start} end={end} canLookUp onCopy={noop} onLookUp={noop} onTranslate={noop} onShare={noop} />);
  /** The menu box, laid out at 200 wide; its position. */
  const placed = async () => {
    const box = screen.container.queryAll((n) => typeof n.props.onLayout === 'function')[0];
    await fireEvent(box, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 38 } } });
    const flat = (n: { props: { style?: unknown } }) => Object.assign({}, ...[n.props.style].flat()) as Record<string, number>;
    // The full-width row (at the menu's height) and the menu in it (at its place along it).
    const row = screen.container.queryAll((n) => n.props.pointerEvents === 'box-none')[0];
    const menuBox = screen.container.queryAll((n) => typeof n.props.onLayout === 'function')[0];
    return { ...flat(row), ...flat(menuBox) };
  };

  it('sits over the middle of a one-line selection, above it', async () => {
    await menu({ x: 150, y: 300, h: 24 }, { x: 250, y: 300, h: 24 });
    const st = await placed();
    expect(st.marginLeft).toBe(100); // centred on x 200
    expect(st.top).toBeLessThan(300);
    expect(st.opacity).toBe(1);
  });

  it('stays on screen at the edge, and goes below the text near the top', async () => {
    await menu({ x: 4, y: 10, h: 24 }, { x: 40, y: 10, h: 24 });
    const st = await placed();
    expect(st.marginLeft).toBeGreaterThanOrEqual(8);
    expect(st.top).toBeGreaterThan(10 + 24);
  });
});

it('a touch between two words selects the closer one', async () => {
  expect(nearestWord(TEXT, 3)).toBe(2); // the space after "The"
  expect(nearestWord('a     word', 5)).toBe(6);
  expect(nearestWord('   a', 0)).toBe(3);
  const { get, run } = await selecting('s8');
  await run((s) => s.selectAt({ b: 0, o: TEXT.indexOf(' fox') }));
  expect(selectionText(get().sel!, textOf)).toBe('brown');
});

it('the phone measures the letters asked for, and they are used from then on', async () => {
  resetWidths();
  const face = { fontFamily: 'Georgia' };
  const onMeasured = jest.fn();
  await render(<CharProbe onMeasured={onMeasured} />);
  await act(async () => {
    charWidth(face, 'a', 16); // not known yet: asked for
    await new Promise((r) => setTimeout(r, 10));
  });
  const probe = screen.container.queryAll((n) => typeof n.props.onTextLayout === 'function')[0];
  expect(probe.props.children).toBe('||\n|aaaa|');
  // Measured at the size it's drawn at.
  expect([probe.props.style].flat(3).find((st: { fontSize?: number } | undefined) => st?.fontSize)?.fontSize).toBe(16);
  await fireEvent(probe, 'textLayout', { nativeEvent: { lines: [{ width: 8 }, { width: 8 + 4 * 7.5 }] } });
  await act(() => new Promise((r) => setTimeout(r, 10)));
  expect(charWidth(face, 'a', 16)).toBe(7.5);
  expect(onMeasured).toHaveBeenCalled();
});
