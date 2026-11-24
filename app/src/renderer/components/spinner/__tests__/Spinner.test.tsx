// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Spinner } from '../Spinner';

afterEach(cleanup);

describe('Spinner', () => {
  test('strokes the arc with a #256156 gradient and spins', () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector('svg')!;
    const gradient = svg.querySelector('linearGradient')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('class')).toContain('animate-spin');
    expect(svg.getAttribute('width')).toBe('12');
    expect(svg.getAttribute('stroke')).toBe(`url(#${gradient.id})`);
    const stops = [...gradient.querySelectorAll('stop')];
    expect(stops.map((s) => s.getAttribute('stop-color'))).toEqual(['#256156', '#256156']);
  });

  test('gives each spinner its own gradient id', () => {
    const { container } = render(
      <>
        <Spinner />
        <Spinner color="#000" size={20} className="ml-2" />
      </>
    );
    const [a, b] = [...container.querySelectorAll('linearGradient')].map((g) => g.id);
    expect(a).not.toBe(b);
    const second = container.querySelectorAll('svg')[1];
    expect(second.getAttribute('width')).toBe('20');
    expect(second.getAttribute('class')).toContain('ml-2');
    expect(second.querySelector('stop')!.getAttribute('stop-color')).toBe('#000');
  });
});
