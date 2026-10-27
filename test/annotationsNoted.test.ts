// Highlighting over a highlight that has a note takes it over, note and all (addHighlight): the
// reader asks first, so it is told which noted highlights a new one would take over whole.

import { expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Alert: { alert: () => {} } }));
vi.mock('expo-file-system', () => ({
  Paths: { document: 'doc' },
  File: class {
    get parentDirectory() {
      return { exists: true };
    }
  },
}));
vi.mock('@/lib/storage', () => ({ readJson: () => null, writeJson: () => {} }));

const { addHighlight, getAnnotations, notedHighlightsTakenOver } = await import('@/lib/annotations');

const TEXT = 'Call me Ishmael. Some years ago, never mind how long precisely.';
const at = (word: string) => {
  const s = TEXT.indexOf(word);
  return { s, e: s + word.length, text: word };
};

it('lists the noted highlights a new highlight would take over whole, and only those', () => {
  addHighlight('moby', { b: 1, ...at('Ishmael'), color: 'yellow', note: 'the narrator' });
  addHighlight('moby', { b: 1, ...at('years ago'), color: 'green', note: 'when?' });
  addHighlight('moby', { b: 1, ...at('never'), color: 'blue' }); // no note: nothing to lose
  addHighlight('moby', { b: 2, s: 0, e: 4, text: 'Call', color: 'pink', note: 'another paragraph' });
  const s = TEXT.indexOf('me');
  const e = TEXT.indexOf('ago') + 3;
  expect(notedHighlightsTakenOver('moby', 1, s, e).map((h) => h.note)).toEqual(['the narrator', 'when?']);
  // Covering only part of "years ago": it keeps the rest, with its note.
  expect(notedHighlightsTakenOver('moby', 1, s, TEXT.indexOf('ago')).map((h) => h.note)).toEqual(['the narrator']);
  expect(notedHighlightsTakenOver('moby', 1, TEXT.indexOf('never'), TEXT.length)).toEqual([]);

  // What it says is what addHighlight then does: those notes go, the others stay.
  addHighlight('moby', { b: 1, s, e, text: TEXT.slice(s, e), color: 'yellow' });
  expect(getAnnotations('moby').highlights.flatMap((h) => h.note ?? [])).toEqual(['another paragraph']);
});
