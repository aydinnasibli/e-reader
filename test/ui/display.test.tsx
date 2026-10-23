/// <reference types="jest" />
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { type ReactNode, useState } from 'react';
import { Text } from 'react-native';
import type { Block } from '@/engine/types';
import { type ReaderSettings, THEMES, setSettings, useSettings } from '@/lib/settings';
import { BookData } from '@/reader/book';
import { DisplayPanel } from '@/reader/DisplayPanel';
import { LivePreview } from '@/reader/LivePreview';
import { Tap } from '@/ui/Tap';

const theme = THEMES.light;
const TEXT = 'It was the best of times, it was the worst of times.';

/** A book whose first chunk is already in memory, as it is while reading. */
function fakeBook(blocks: Block[]) {
  const book = new BookData({ id: 'x', title: 'Book' } as never);
  book.chunks = [[0, 0]];
  book.totalBlocks = blocks.length;
  (book as unknown as { cache: Map<number, Block[]> }).cache.set(0, blocks);
  return book;
}

const fontSizeOf = (text: string | RegExp) => [screen.getByText(text).props.style].flat().find((s) => s?.fontSize)?.fontSize;

/** The reader's wiring: the panel's slider feeds a draft drawn by LivePreview. */
function Reader({ book, onSlide }: { book: BookData; onSlide: jest.Mock }) {
  const settings = useSettings();
  const [draft, setDraft] = useState<Partial<ReaderSettings> | null>(null);
  let page: ReactNode = <Text>{`saved size ${settings.fontSize}`}</Text>;
  if (draft) page = <LivePreview book={book} settings={{ ...settings, ...draft }} theme={theme} pos={{ b: 0, o: 0 }} />;
  return (
    <>
      {page}
      <DisplayPanel
        visible
        onClose={() => {}}
        settings={settings}
        theme={theme}
        onSlide={(patch, done) => {
          onSlide(patch, done);
          if (done) {
            setSettings(patch);
            setDraft(null);
          } else setDraft((d) => ({ ...d, ...patch }));
        }}
      />
    </>
  );
}

describe('display panel', () => {
  beforeEach(() => setSettings({ fontSize: 19, mode: 'page', indent: false }));

  it('the size slider changes the page text while dragging, and saves on release', async () => {
    const onSlide = jest.fn();
    await render(<Reader book={fakeBook([{ k: 'p', r: [TEXT] }])} onSlide={onSlide} />);
    const slider = screen.getByTestId('slider-Size');

    await fireEvent(slider, 'valueChange', 24.4);
    expect(onSlide).toHaveBeenLastCalledWith({ fontSize: 24 }, false);
    expect(fontSizeOf(TEXT)).toBe(24); // the page text, live
    expect(screen.getByText('24')).toBeTruthy(); // the value next to the slider

    await fireEvent(slider, 'valueChange', 31);
    expect(fontSizeOf(TEXT)).toBe(31);

    await fireEvent(slider, 'slidingComplete', 31);
    expect(onSlide).toHaveBeenLastCalledWith({ fontSize: 31 }, true);
    expect(screen.getByText('saved size 31')).toBeTruthy();
  });

  it('ignores slider movement that does not change the value', async () => {
    const onSlide = jest.fn();
    await render(<Reader book={fakeBook([{ k: 'p', r: [TEXT] }])} onSlide={onSlide} />);
    const slider = screen.getByTestId('slider-Size');
    await fireEvent(slider, 'valueChange', 20.1);
    await fireEvent(slider, 'valueChange', 20.3);
    await fireEvent(slider, 'valueChange', 19.8);
    expect(onSlide).toHaveBeenCalledTimes(1);
  });

  it('spacing sliders are live too', async () => {
    const onSlide = jest.fn();
    await render(<Reader book={fakeBook([{ k: 'p', r: [TEXT] }])} onSlide={onSlide} />);
    await fireEvent.press(screen.getByText('Spacing'));
    await fireEvent(screen.getByTestId('slider-Line spacing'), 'valueChange', 2.02);
    expect(onSlide).toHaveBeenLastCalledWith({ lineSpacing: 2 }, false);
    const lh = [screen.getByText(TEXT).props.style].flat().find((s) => s?.lineHeight)?.lineHeight;
    expect(lh).toBe(Math.round(19 * 2));
  });
});

describe('live preview', () => {
  it('starts at the reading position, mid-paragraph', async () => {
    setSettings({ indent: false, hyphenate: false });
    const book = fakeBook([{ k: 'p', r: [TEXT] }, { k: 'p', r: ['Next paragraph.'] }]);
    await render(<LivePreview book={book} settings={await useSettingsSnapshot()} theme={theme} pos={{ b: 0, o: TEXT.indexOf('it was the worst') }} />);
    expect(screen.getByText('it was the worst of times.')).toBeTruthy();
    expect(screen.getByText('Next paragraph.')).toBeTruthy();
    expect(screen.queryByText(/best of times/)).toBeNull();
  });
});

async function useSettingsSnapshot(): Promise<ReaderSettings> {
  let s: ReaderSettings | undefined;
  function Grab() {
    s = useSettings();
    return null;
  }
  await render(<Grab />);
  return s!;
}

describe('controls answer the finger', () => {
  beforeEach(() => setSettings({ fontSize: 19, mode: 'page', indent: false }));
  const scrollEnabled = () => screen.container.queryAll((n) => n.props.scrollEnabled !== undefined && n.props.showsVerticalScrollIndicator === false)[0].props.scrollEnabled;

  it('while a slider is dragged the panel does not scroll; each step ticks', async () => {
    const tick = jest.spyOn(Haptics, 'selectionAsync');
    await render(<Reader book={fakeBook([{ k: 'p', r: [TEXT] }])} onSlide={jest.fn()} />);
    const slider = screen.getByTestId('slider-Size');
    expect(slider.props.tapToSeek).toBe(true);
    await fireEvent(slider, 'slidingStart', 19);
    expect(scrollEnabled()).toBe(false);
    await fireEvent(slider, 'valueChange', 20.2);
    await fireEvent(slider, 'valueChange', 20.4); // same step: no second tick
    expect(tick).toHaveBeenCalledTimes(1);
    await fireEvent(slider, 'slidingComplete', 20.4);
    expect(scrollEnabled()).toBe(true);
    tick.mockRestore();
  });

  it('options tick when picked, not when the chosen one is tapped again', async () => {
    const tick = jest.spyOn(Haptics, 'selectionAsync');
    await render(<Reader book={fakeBook([{ k: 'p', r: [TEXT] }])} onSlide={jest.fn()} />);
    await fireEvent.press(screen.getByText('Page'));
    await fireEvent.press(screen.getByText('Scroll'));
    expect(tick).toHaveBeenCalledTimes(2); // the tab, then the mode
    expect(screen.getByText('Scroll').props.style.color).toBe('#fff');
    await fireEvent.press(screen.getByText('Scroll'));
    expect(tick).toHaveBeenCalledTimes(2);
    tick.mockRestore();
  });
});

describe('Tap', () => {
  it('a faded (disabled) button fades further from where it is, and haptics are per kind', async () => {
    const tick = jest.spyOn(Haptics, 'selectionAsync');
    const tap = jest.spyOn(Haptics, 'impactAsync');
    const onPress = jest.fn();
    await render(
      <>
        <Tap accessibilityLabel="pick" haptic="select" onPress={onPress} />
        <Tap accessibilityLabel="act" haptic="light" onPress={onPress} />
        <Tap accessibilityLabel="plain" onPress={onPress} style={{ opacity: 0.3 }} />
      </>,
    );
    await fireEvent.press(screen.getByLabelText('pick'));
    await fireEvent.press(screen.getByLabelText('act'));
    await fireEvent.press(screen.getByLabelText('plain'));
    expect(onPress).toHaveBeenCalledTimes(3);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(tap).toHaveBeenCalledTimes(1);
    expect([screen.getByLabelText('plain').props.style].flat().find((s) => s && 'opacity' in s)?.opacity).toBe(0.3);
    tick.mockRestore();
    tap.mockRestore();
  });
});
