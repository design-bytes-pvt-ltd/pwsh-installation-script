import { describe, expect, test } from 'vitest';
import { diffPixels } from '../diff';

/** n RGBA pixels of one colour. */
const pixels = (n: number, [r, g, b, a]: number[]) => Uint8ClampedArray.from({ length: n * 4 }, (_, i) => [r, g, b, a][i % 4]);

describe('diffPixels', () => {
  test('identical images have no differences', () => {
    const a = pixels(10, [10, 20, 30, 255]);
    expect(diffPixels(a, a.slice())).toMatchObject({ mismatched: 0, compared: 10, ratio: 0 });
  });

  test('counts and marks changed pixels in magenta', () => {
    const a = pixels(4, [0, 0, 0, 255]);
    const b = a.slice();
    b.set([200, 0, 0, 255], 4); // second pixel differs
    const r = diffPixels(a, b);
    expect(r).toMatchObject({ mismatched: 1, compared: 4, ratio: 0.25 });
    expect(Array.from(r.data.slice(4, 8))).toEqual([255, 0, 255, 255]);
  });

  test('differences up to the threshold count as matches', () => {
    const a = pixels(1, [100, 100, 100, 255]);
    const b = pixels(1, [110, 100, 100, 255]);
    expect(diffPixels(a, b, 10).mismatched).toBe(0);
    expect(diffPixels(a, b, 9).mismatched).toBe(1);
  });

  test('ignores pixels the design does not cover', () => {
    const r = diffPixels(pixels(2, [0, 0, 0, 255]), pixels(2, [255, 255, 255, 0]));
    expect(r).toMatchObject({ mismatched: 0, compared: 0, ratio: 0 });
  });

  test('rejects buffers of different sizes', () => {
    expect(() => diffPixels(pixels(1, [0, 0, 0, 0]), pixels(2, [0, 0, 0, 0]))).toThrow();
  });
});
