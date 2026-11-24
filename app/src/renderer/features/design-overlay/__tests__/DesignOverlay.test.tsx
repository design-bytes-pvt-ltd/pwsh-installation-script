// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { polyfillResizeObserver } from '@/test/fakeInstallerApi';
import { DesignOverlay } from '../components/DesignOverlay';

polyfillResizeObserver();

/** jsdom never decodes images: stand in for <img> with one that loads at a fixed size. */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 1000;
  naturalHeight = 690;
  set src(_v: string) {
    queueMicrotask(() => this.onload?.());
  }
}

const key = (k: string, opts: KeyboardEventInit = {}, target: Window | Element = window) =>
  act(() => {
    fireEvent.keyDown(target, { key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, ...opts });
  });
const mod = (k: string) => key(k, { ctrlKey: true, shiftKey: true });

const toolbar = () => screen.queryByRole('dialog', { name: 'Design overlay' });
const image = () => screen.getByTestId('design-overlay-image');

async function openWithImage() {
  render(<DesignOverlay />);
  mod('D');
  const input = screen.getByTestId('design-overlay-file');
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File(['png'], 'screen.png', { type: 'image/png' })] } });
  });
  return screen.findByTestId('design-overlay-image');
}

beforeEach(() => {
  vi.stubGlobal('Image', FakeImage);
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('DesignOverlay', () => {
  test('renders nothing until Ctrl+Shift+D, which toggles it', () => {
    render(<DesignOverlay />);
    expect(toolbar()).toBeNull();
    mod('D');
    expect(toolbar()).not.toBeNull();
    mod('D');
    expect(toolbar()).toBeNull();
  });

  test('other keys reach the app untouched while closed', () => {
    render(<DesignOverlay />);
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  test('uploads an image and shows it at 50% opacity', async () => {
    const img = await openWithImage();
    expect(img.style.opacity).toBe('0.5');
    expect(img.style.width).toBe('1000px');
    expect(screen.getByText('screen.png')).toBeTruthy();
  });

  test('rejects a non-image file with a message', async () => {
    render(<DesignOverlay />);
    mod('D');
    await act(async () => {
      fireEvent.change(screen.getByTestId('design-overlay-file'), {
        target: { files: [new File(['gif'], 'anim.gif', { type: 'image/gif' })] },
      });
    });
    expect(screen.getByRole('alert').textContent).toMatch(/not a PNG or JPEG/);
  });

  test('opacity shortcuts, arrow nudges and reset', async () => {
    await openWithImage();
    mod('ArrowUp');
    expect(image().style.opacity).toBe('0.55');
    expect(screen.getByRole('slider', { name: 'Opacity' }).getAttribute('aria-valuenow')).toBe('55');
    mod('ArrowDown');
    mod('ArrowDown');
    expect(image().style.opacity).toBe('0.45');

    key('ArrowRight');
    key('ArrowDown', { shiftKey: true });
    expect(image().style.transform).toBe('translate(1px, 10px)');

    mod('R');
    expect(image().style.transform).toBe('translate(0px, 0px)');
    expect(image().style.opacity).toBe('0.5');
  });

  test('arrows do not move the image when locked or while typing in a field', async () => {
    await openWithImage();
    const x = screen.getByRole('spinbutton', { name: 'Position X' });
    key('ArrowRight', {}, x);
    expect(image().style.transform).toBe('translate(0px, 0px)');

    fireEvent.click(screen.getByRole('button', { name: 'Lock position' }));
    key('ArrowRight');
    expect(image().style.transform).toBe('translate(0px, 0px)');
  });

  test('visibility toggles without removing the image', async () => {
    await openWithImage();
    fireEvent.click(screen.getByRole('button', { name: 'Hide reference' }));
    expect(screen.queryByTestId('design-overlay-image')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show reference' }));
    expect(image()).toBeTruthy();
  });

  test('the image lets clicks through unless click-through is turned off', async () => {
    await openWithImage();
    expect(image().className).toContain('pointer-events-none');
    fireEvent.click(screen.getByRole('button', { name: /Click-through/ }));
    expect(image().className).toContain('pointer-events-auto');
  });

  test('remembers settings and the image for the session', async () => {
    await openWithImage();
    mod('ArrowUp');
    cleanup();
    render(<DesignOverlay />);
    expect(toolbar()).not.toBeNull();
    expect(image().style.opacity).toBe('0.55');
  });

  test('Close hides it; unmount removes its listeners', async () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    await openWithImage();
    fireEvent.click(screen.getByRole('button', { name: /Close overlay/ }));
    expect(toolbar()).toBeNull();
    cleanup();
    const removed = remove.mock.calls.map(([type]) => type);
    expect(removed).toContain('keydown');
    expect(removed).toContain('resize');
    expect(removed).toContain('paste');
  });
});
