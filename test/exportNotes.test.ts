import { describe, expect, it } from 'vitest';
import { exportFileName, notesMarkdown } from '../src/lib/exportNotes';

describe('export highlights', () => {
  it('books, chapters, quotes and notes', () => {
    const md = notesMarkdown(
      [
        {
          title: 'Moby-Dick',
          author: 'Herman Melville',
          highlights: [
            { text: 'Call me Ishmael.', chapter: 'Loomings', color: 'yellow' },
            { text: 'Whenever I find myself\ngrowing grim', note: 'Same.', chapter: 'Loomings', color: 'green' },
            { text: 'The Carpet-Bag', chapter: 'The Carpet-Bag', color: 'blue' },
          ],
        },
        { title: 'Empty', author: '', highlights: [] },
      ],
      new Date(2026, 9, 23),
    );
    expect(md).toContain('## Moby-Dick — Herman Melville');
    expect(md.match(/### Loomings/g)).toHaveLength(1);
    expect(md).toContain('> Call me Ishmael.');
    expect(md).toContain('> Whenever I find myself\n> growing grim');
    expect(md).toContain('**Note:** Same.');
    expect(md).not.toContain('Empty');
  });

  it('file names', () => {
    expect(exportFileName('War and Peace: Vol 1/2')).toBe('War and Peace Vol 1 2.md');
    expect(exportFileName('   ')).toBe('Highlights.md');
  });
});
