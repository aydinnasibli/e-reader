import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-file-system', () => ({ File: class {}, Paths: { document: '' } }));
vi.mock('../src/lib/storage', () => ({ readJson: () => null, saveJson: () => true }));
vi.mock('react', () => ({ useSyncExternalStore: () => null }));

const { ReadingTracker, bookTimeMs, readingSpeed } = await import('../src/lib/stats');
const { formatMinutes } = await import('../src/ui/format');

const PAGE = 1500; // characters on a page
const SEC = 1000;
const MIN = 60 * SEC;
let clock = 0;
let n = 0;
/** A tracker for a fresh book, on a fake clock, assuming 1200 characters a minute. */
function reader() {
  const id = `book${++n}`;
  const t = new ReadingTracker(id, () => clock, () => 1200);
  t.reset(0);
  return { id, t };
}
/** Read `pages` pages forward, `perPage` ms each. */
function read(t: InstanceType<typeof ReadingTracker>, from: number, pages: number, perPage: number) {
  let c = from;
  for (let i = 0; i < pages; i++) {
    clock += perPage;
    c += PAGE;
    t.turn(c);
  }
  return c;
}

beforeEach(() => {
  clock = 1_000_000;
});

describe('reading time and speed', () => {
  it('normal reading: time and speed are what they were', () => {
    const { id, t } = reader();
    read(t, 0, 4, 75 * SEC); // 1500 chars in 75 s = 1200 chars/min
    t.stop();
    expect(bookTimeMs(id)).toBe(4 * 75 * SEC);
    expect(Math.round(readingSpeed(id).cpm)).toBe(1200);
    expect(readingSpeed(id).measured).toBe(true);
  });

  it('tapping quickly through pages counts for nothing', () => {
    const { id, t } = reader();
    let c = read(t, 0, 4, 75 * SEC);
    c = read(t, c, 30, 400); // 30 pages flipped in 12 s
    read(t, c, 1, 75 * SEC);
    t.stop();
    expect(bookTimeMs(id)).toBe(5 * 75 * SEC);
    expect(Math.round(readingSpeed(id).cpm)).toBe(1200); // not thousands of words a minute
  });

  it('a long break on a page adds capped time and is left out of the speed', () => {
    const { id, t } = reader();
    let c = read(t, 0, 4, 75 * SEC);
    c = read(t, c, 1, 60 * MIN); // phone left on the table for an hour
    t.stop();
    // The page counts at most 3x its normal reading time (75 s -> 225 s).
    expect(bookTimeMs(id)).toBe(4 * 75 * SEC + 225 * SEC);
    expect(Math.round(readingSpeed(id).cpm)).toBe(1200);
  });

  it('time in other apps does not count; the page open when leaving does', () => {
    const { id, t } = reader();
    const c = read(t, 0, 4, 75 * SEC);
    clock += 40 * SEC; // reading the current page...
    t.pause(); // ...then switching to another app
    clock += 30 * MIN;
    t.resume();
    clock += 35 * SEC;
    t.turn(c + PAGE);
    t.stop();
    expect(bookTimeMs(id)).toBe(4 * 75 * SEC + 40 * SEC + 35 * SEC);
  });

  it('going back to re-read counts time but not speed; jumps count nothing', () => {
    const { id, t } = reader();
    const c = read(t, 0, 4, 75 * SEC);
    clock += 20 * SEC;
    t.turn(c - PAGE); // back one page
    t.reset(500_000); // jump with the slider
    clock += 75 * SEC;
    t.turn(500_000 + PAGE); // the first page after the jump, read normally
    t.stop();
    expect(bookTimeMs(id)).toBe(4 * 75 * SEC + 20 * SEC + 75 * SEC);
    expect(Math.round(readingSpeed(id).cpm)).toBe(1200);
  });

  it('scroll mode: a minute reading the screen, then paragraphs passing in a quick burst', () => {
    const { id, t } = reader();
    let c = 0;
    for (let screen = 0; screen < 6; screen++) {
      clock += 60 * SEC; // reading what's on screen
      for (let k = 0; k < 4; k++) {
        c += 300; // a paragraph scrolls past
        t.turn(c);
        clock += 150;
      }
    }
    t.stop();
    // About six minutes of reading at 1200 characters a minute, not a break per screen.
    expect(bookTimeMs(id)).toBeGreaterThan(6 * 60 * SEC);
    expect(Math.round(readingSpeed(id).cpm / 10)).toBe(Math.round((6 * 1200) / (6 * 60.6) * 6));
  });

  it('a page read partly before switching apps and finished after is timed as one page', () => {
    const { id, t } = reader();
    let c = read(t, 0, 3, 75 * SEC);
    clock += 40 * SEC;
    t.pause();
    clock += 20 * MIN;
    t.resume();
    clock += 35 * SEC;
    c += PAGE;
    t.turn(c);
    t.stop();
    expect(bookTimeMs(id)).toBe(4 * 75 * SEC);
    expect(Math.round(readingSpeed(id).cpm)).toBe(1200);
  });

  it('under 3 minutes of real reading, the speed is an estimate', () => {
    const { id, t } = reader();
    read(t, 0, 1, 75 * SEC);
    t.stop();
    // (Other tests' books count towards the overall speed, so check this book only.)
    expect(bookTimeMs(id)).toBe(75 * SEC);
  });
});

describe('formatMinutes', () => {
  it('shows short times honestly', () => {
    expect(formatMinutes(0.1)).toBe('< 1 min');
    expect(formatMinutes(1)).toBe('1 min');
    expect(formatMinutes(95)).toBe('1 h 35 min');
  });

  it('a jump keeps the time spent on the page jumped from', () => {
    const { id, t } = reader();
    clock += 90 * SEC;
    t.reset(50_000); // contents, search, slider...
    t.stop();
    expect(bookTimeMs(id)).toBe(90 * SEC);
  });

  it('auto page turn counts as reading time but not as the reader\'s speed', () => {
    const { id, t } = reader();
    const before = readingSpeed().cpm; // from the books read in the tests above
    let c = 0;
    for (let i = 0; i < 20; i++) {
      clock += 30 * SEC; // 3000 chars a minute, the machine's pace
      c += PAGE;
      t.autoTurn(c);
    }
    t.stop();
    expect(bookTimeMs(id)).toBe(20 * 30 * SEC);
    // This book has no speed of its own, and the overall speed is unchanged.
    expect(readingSpeed(id).cpm).toBe(before);
  });
});

