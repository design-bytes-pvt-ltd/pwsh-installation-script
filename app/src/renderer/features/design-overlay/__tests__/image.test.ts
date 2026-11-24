// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MAX_IMAGE_BYTES, readReferenceImage, validateImageFile } from '../image';

const file = (name: string, type: string, bytes = 4) => new File([new Uint8Array(bytes)], name, { type });

/** jsdom never decodes images, so stand in for <img> with one that loads (or fails). */
function mockImage(outcome: 'load' | 'error', size = { w: 200, h: 100 }) {
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = size.w;
    naturalHeight = size.h;
    set src(_v: string) {
      queueMicrotask(() => (outcome === 'load' ? this.onload?.() : this.onerror?.()));
    }
  }
  vi.stubGlobal('Image', FakeImage);
}

afterEach(() => vi.unstubAllGlobals());

describe('validateImageFile', () => {
  test('accepts PNG and JPEG', () => {
    expect(validateImageFile(file('a.png', 'image/png'))).toBeNull();
    expect(validateImageFile(file('a.JPG', 'image/jpeg'))).toBeNull();
    expect(validateImageFile(file('a.jpeg', 'image/jpeg'))).toBeNull();
  });

  test('rejects other types and mismatched extensions', () => {
    expect(validateImageFile(file('a.gif', 'image/gif'))).toMatch(/not a PNG or JPEG/);
    expect(validateImageFile(file('a.svg', 'image/svg+xml'))).toMatch(/not a PNG or JPEG/);
    expect(validateImageFile(file('a.png', 'text/plain'))).toMatch(/not a PNG or JPEG/);
    expect(validateImageFile(file('a.txt', 'image/png'))).toMatch(/not a PNG or JPEG/);
  });

  test('pasted images may have no extension', () => {
    expect(validateImageFile(file('image', 'image/png'), { requireExtension: false })).toBeNull();
  });

  test('rejects empty and oversized files', () => {
    expect(validateImageFile(file('a.png', 'image/png', 0))).toMatch(/empty/);
    expect(validateImageFile({ name: 'a.png', type: 'image/png', size: MAX_IMAGE_BYTES + 1 })).toMatch(/limit/);
  });
});

describe('readReferenceImage', () => {
  test('returns a data URL and the natural size', async () => {
    mockImage('load', { w: 2000, h: 1380 });
    const img = await readReferenceImage(file('screen.png', 'image/png'));
    expect(img).toMatchObject({ name: 'screen.png', width: 2000, height: 1380, bytes: 4 });
    expect(img.src).toMatch(/^data:image\/png;base64,/);
  });

  test('reports a file that is not really an image', async () => {
    mockImage('error');
    await expect(readReferenceImage(file('fake.png', 'image/png'))).rejects.toThrow(/not a valid PNG or JPEG/);
  });

  test('reports validation errors without reading the file', async () => {
    await expect(readReferenceImage(file('a.gif', 'image/gif'))).rejects.toThrow(/not a PNG or JPEG/);
  });
});
