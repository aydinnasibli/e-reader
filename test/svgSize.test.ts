import { describe, expect, it } from 'vitest';
import { svgSize } from '../src/reader/svgSize';

describe('the size of an SVG picture, from its markup', () => {
  it('its width and height', () => {
    expect(svgSize('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400">')).toEqual({ width: 600, height: 400 });
    expect(svgSize("<svg width='30pt' height='15pt'>")).toEqual({ width: 40, height: 20 });
  });

  it('the viewBox, or the viewBox with one of them', () => {
    expect(svgSize('<svg viewBox="0 0 1200 800" xmlns="http://www.w3.org/2000/svg">')).toEqual({ width: 1200, height: 800 });
    expect(svgSize('<svg width="300" viewBox="0,0,1200,800">')).toEqual({ width: 300, height: 200 });
    // A percentage says nothing about the picture: the viewBox does.
    expect(svgSize('<svg width="100%" height="100%" viewBox="0 0 640 480">')).toEqual({ width: 640, height: 480 });
  });

  it('nothing to go by', () => {
    expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg">')).toBeNull();
    expect(svgSize('not a picture')).toBeNull();
  });
});
