import { describe, expect, it } from 'vitest';
import { MAX_WPM, MIN_WPM, pageDelay, scrollSpeed, stepWpm } from '../src/reader/autoRead';

describe('auto page turn', () => {
  it('a page stays as long as reading it takes', () => {
    // 1500 characters at 250 wpm (1500 chars/min): one minute.
    expect(pageDelay(1500, 250)).toBe(60_000);
    // A short last page of a chapter turns sooner, but never in under 2 s.
    expect(pageDelay(300, 250)).toBe(12_000);
    expect(pageDelay(5, 250)).toBe(2000);
  });

  it('speed buttons move about 10% and stay in range', () => {
    expect(stepWpm(200, 1)).toBe(220);
    expect(stepWpm(200, -1)).toBe(180);
    expect(stepWpm(MAX_WPM, 1)).toBe(MAX_WPM);
    expect(stepWpm(MIN_WPM, -1)).toBe(MIN_WPM);
    expect(stepWpm(60, 1)).toBe(70); // small numbers still move
  });

  it('scrolls faster for faster reading and bigger text', () => {
    const base = scrollSpeed(250, 350, 19, 28);
    expect(scrollSpeed(500, 350, 19, 28)).toBeCloseTo(base * 2);
    expect(scrollSpeed(250, 350, 19, 40)).toBeGreaterThan(base);
    // 1500 chars/min, ~37 chars per line at 28 pt lines: about 19 pt a second.
    expect(base).toBeGreaterThan(15);
    expect(base).toBeLessThan(25);
  });
});
