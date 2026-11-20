// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Banner } from '../Banner';

afterEach(cleanup);

describe('Banner', () => {
  test('renders the image inside a rounded, clipped frame', () => {
    render(<Banner src="/hero.svg" alt="Hero banner" />);
    const img = screen.getByRole('img', { name: 'Hero banner' });
    expect(img.getAttribute('src')).toBe('/hero.svg');
    expect(img.className).toContain('object-cover');
    const frame = img.parentElement!;
    expect(frame.dataset.slot).toBe('banner');
    expect(frame.className).toContain('rounded-lg');
    expect(frame.className).toContain('overflow-hidden');
  });

  test('merges frame and image classes and passes img props through', () => {
    render(
      <Banner src="/x.svg" alt="X" className="rounded-xl" imgClassName="object-contain" loading="lazy" />
    );
    const img = screen.getByRole('img', { name: 'X' });
    expect(img.parentElement!.className).toContain('rounded-xl');
    expect(img.parentElement!.className).not.toContain('rounded-lg');
    expect(img.className).toContain('object-contain');
    expect(img.className).not.toContain('object-cover');
    expect(img.getAttribute('loading')).toBe('lazy');
  });
});
