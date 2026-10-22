import { describe, expect, it } from 'vitest';
import { swipeOutcome, tapZone } from '../src/reader/gestures';

const W = 390; // an iPhone's width in points

describe('tap zones', () => {
  it('left 30% back, middle 40% menu, right 30% forward', () => {
    expect(tapZone(20, W)).toBe('prev');
    expect(tapZone(W * 0.29, W)).toBe('prev');
    expect(tapZone(W * 0.5, W)).toBe('menu');
    // "A bit right of the middle" is still the menu.
    expect(tapZone(W * 0.6, W)).toBe('menu');
    expect(tapZone(W * 0.69, W)).toBe('menu');
    expect(tapZone(W * 0.71, W)).toBe('next');
  });
});

describe('swipes', () => {
  it('a tapping finger that wobbles quickly is a tap, not a page turn', () => {
    // 9–20 pt in a few ms used to turn the page (velocity alone was enough).
    expect(swipeOutcome(-9, -0.9, W)).toBe('tap');
    expect(swipeOutcome(-20, -1.2, W)).toBe('tap');
    expect(swipeOutcome(15, 0.8, W)).toBe('tap');
  });

  it('a real swipe turns the page', () => {
    expect(swipeOutcome(-120, -0.2, W)).toBe('next'); // slow but long
    expect(swipeOutcome(90, 0.1, W)).toBe('prev');
    expect(swipeOutcome(-40, -0.9, W)).toBe('next'); // short but a deliberate flick
  });

  it('a hesitant drag that comes back does nothing', () => {
    expect(swipeOutcome(-30, 0.3, W)).toBe('none');
    expect(swipeOutcome(-40, 0.9, W)).toBe('none'); // flicked back the other way
  });
});
