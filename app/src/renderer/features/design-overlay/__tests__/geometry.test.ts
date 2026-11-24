import { describe, expect, test } from 'vitest';
import { guessDensity, placeToolbar, referenceSize } from '../geometry';

const viewport = { width: 1000, height: 690 };

describe('referenceSize', () => {
  test('shows a 2x export at half its pixel size, then applies the scale', () => {
    expect(referenceSize({ width: 2000, height: 1380 }, { density: 2, fit: false, scale: 1 }, viewport)).toEqual({ width: 1000, height: 690 });
    expect(referenceSize({ width: 2000, height: 1380 }, { density: 2, fit: false, scale: 0.5 }, viewport)).toEqual({ width: 500, height: 345 });
  });

  test('fit scales into the viewport and keeps the aspect ratio', () => {
    const s = referenceSize({ width: 1440, height: 2000 }, { density: 1, fit: true, scale: 1 }, viewport);
    expect(s.height).toBeCloseTo(690);
    expect(s.width / s.height).toBeCloseTo(1440 / 2000);
  });
});

test('guessDensity compares the image width with the window', () => {
  expect(guessDensity(1000, 1000)).toBe(1);
  expect(guessDensity(1440, 1000)).toBe(1);
  expect(guessDensity(2000, 1000)).toBe(2);
  expect(guessDensity(3000, 1000)).toBe(3);
});

describe('placeToolbar', () => {
  const size = { width: 288, height: 400 };
  test('defaults to the top-right corner', () => {
    expect(placeToolbar({ x: null, y: null }, size, viewport)).toEqual({ x: 1000 - 288 - 12, y: 12 });
  });
  test('keeps the toolbar inside the window', () => {
    expect(placeToolbar({ x: -50, y: 5000 }, size, viewport)).toEqual({ x: 12, y: 690 - 400 - 12 });
  });
});
