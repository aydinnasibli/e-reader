import { describe, expect, it } from 'vitest';
import { isBackMatter, storyEnd } from '../src/reader/finish';

const toc = (...titles: string[]) => titles.map((t, i) => ({ t, l: 0, b: i * 100 }));

describe('when a book is finished', () => {
  it('recognises back matter titles', () => {
    for (const t of ['Notes', 'NOTES.', 'Acknowledgments', 'About the Author', 'Also by Haruki Murakami', 'Примечания', 'Об авторе', 'Qeydlər', 'Yazar Hakkında', 'A Preview of The Next Book'])
      expect(isBackMatter(t)).toBe(true);
    for (const t of ['Chapter 12', 'Epilogue', 'The Notes of a Madman', 'Глава 3', 'Index Cards and Other Stories']) expect(isBackMatter(t)).toBe(false);
  });

  it('the story ends where the trailing back matter starts', () => {
    expect(storyEnd(toc('One', 'Two', 'Three', 'Acknowledgements', 'Notes'), 500)).toBe(300);
    // Back matter in the middle doesn't count; only what ends the book.
    expect(storyEnd(toc('One', 'Notes', 'Two', 'Three'), 400)).toBeNull();
    // A book with no back matter ends on its last page.
    expect(storyEnd(toc('One', 'Two'), 200)).toBeNull();
    // Too early in the book to be trusted.
    expect(storyEnd(toc('Preface', 'Notes'), 1000)).toBeNull();
  });
});
