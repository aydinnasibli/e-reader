import { describe, expect, it } from 'vitest';
import { finishesBook, isBackMatter, storyEnd } from '../src/reader/finish';

const toc = (...titles: string[]) => titles.map((t, i) => ({ t, l: 0, b: i * 100 }));

describe('when a book is finished', () => {
  it('recognises back matter titles', () => {
    for (const t of ['Notes', 'NOTES.', 'Acknowledgments', 'About the Author', 'Also by Haruki Murakami', 'Примечания', 'Об авторе', 'Qeydlər', 'Yazar Hakkında', 'A Preview of The Next Book'])
      expect(isBackMatter(t)).toBe(true);
    for (const t of ['Chapter 12', 'Epilogue', 'The Notes of a Madman', 'Глава 3', 'Index Cards and Other Stories']) expect(isBackMatter(t)).toBe(false);
  });

  it('Turkish titles in capitals, with the dotted and dotless i', () => {
    for (const t of ['YAZAR HAKKINDA', 'İçindekiler', 'İÇİNDEKİLER', 'DİZİN', 'KAYNAKÇA', 'TEŞEKKÜRLER', 'Yazar hakkında'])
      expect(isBackMatter(t)).toBe(true);
    expect(isBackMatter('BİRİNCİ BÖLÜM')).toBe(false);
  });

  // Blocks are 100 characters each here.
  const at = (b: number) => b * 100;

  it('the story ends where the trailing back matter starts', () => {
    expect(storyEnd(toc('One', 'Two', 'Three', 'Acknowledgements', 'Notes'), at, 50_000)).toBe(300);
    // Back matter in the middle doesn't count; only what ends the book.
    expect(storyEnd(toc('One', 'Notes', 'Two', 'Three'), at, 40_000)).toBeNull();
    // A book with no back matter ends on its last page.
    expect(storyEnd(toc('One', 'Two'), at, 20_000)).toBeNull();
    // Too early in the book to be trusted.
    expect(storyEnd(toc('Preface', 'Notes'), at, 100_000)).toBeNull();
  });

  it('notes split by chapter, and a long index, still end the story', () => {
    const nested = [
      { t: 'One', l: 0, b: 0 },
      { t: 'Two', l: 0, b: 100 },
      { t: 'Notes', l: 0, b: 200 },
      { t: 'Chapter 1', l: 1, b: 210 },
      { t: 'Chapter 2', l: 1, b: 220 },
      { t: 'Index', l: 0, b: 300 },
    ];
    expect(storyEnd(nested, at, 25_000)).toBe(200);
    // The index has far more (tiny) blocks than the story, but fewer characters.
    expect(storyEnd(toc('One', 'Index'), (b) => (b === 0 ? 0 : 90_000), 100_000)).toBe(100);
  });
});

describe('which moves finish a book', () => {
  // The story is blocks 0–899, the notes start at 900, the last page shows block 990.
  const step = (o: Partial<Parameters<typeof finishesBook>[0]>) =>
    finishesBook({ runStart: 100, prev: 880, now: 890, turnedToLast: false, storyEnd: 900, ...o });

  it('turning pages from the story into the notes, or onto the last page', () => {
    expect(step({ prev: 895, now: 905 })).toBe(true);
    expect(step({ prev: 980, now: 990, turnedToLast: true })).toBe(true);
    expect(step({ prev: 880, now: 890 })).toBe(false); // still in the story
  });

  it('not by jumping, or reading notes that were jumped to', () => {
    expect(step({ runStart: null, prev: 300, now: 905 })).toBe(false); // the jump itself
    expect(step({ runStart: 905, prev: 905, now: 910 })).toBe(false); // turning a page in the notes
    expect(step({ runStart: 905, prev: 980, now: 990, turnedToLast: true })).toBe(false); // ...to the end of them
  });

  it('not by laying pages out again (font change, rotation): the reader says it was no page turn', () => {
    expect(step({ prev: 980, now: 990, turnedToLast: false })).toBe(false);
    expect(step({ prev: 905, now: 905 })).toBe(false);
  });

  it('books without back matter: the last page', () => {
    expect(step({ storyEnd: null, prev: 980, now: 990, turnedToLast: true })).toBe(true);
    expect(step({ storyEnd: null, prev: 980, now: 985 })).toBe(false);
  });
});

