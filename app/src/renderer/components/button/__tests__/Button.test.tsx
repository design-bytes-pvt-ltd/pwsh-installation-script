// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Button } from '../Button';

afterEach(cleanup);

describe('Button', () => {
  test('defaults to the primary variant and type="button"', () => {
    render(<Button>Launch Enterprise Brain</Button>);
    const el = screen.getByRole('button', { name: 'Launch Enterprise Brain' });
    expect(el.getAttribute('type')).toBe('button');
    expect(el.dataset.variant).toBe('primary');
    expect(el.className).toContain('from-button-primary-from');
    expect(el.className).toContain('rounded-full');
  });

  test('secondary variant uses the bordered style', () => {
    render(<Button variant="secondary">Exit</Button>);
    const el = screen.getByRole('button', { name: 'Exit' });
    expect(el.dataset.variant).toBe('secondary');
    expect(el.className).toContain('border-button-secondary-border');
    expect(el.className).not.toContain('from-button-primary-from');
  });

  test('never adds a box shadow', () => {
    render(
      <>
        <Button>One</Button>
        <Button variant="secondary">Two</Button>
      </>
    );
    for (const el of screen.getAllByRole('button')) {
      expect(el.className).not.toMatch(/(^|\s)(shadow-(?!none)|ring-)/);
    }
  });

  test('disabled buttons fade out and ignore clicks', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Get started
      </Button>
    );
    const el = screen.getByRole('button', { name: 'Get started' }) as HTMLButtonElement;
    expect(el.disabled).toBe(true);
    expect(el.className).toContain('disabled:opacity-50');
    fireEvent.click(el);
    expect(onClick).not.toHaveBeenCalled();
  });

  test('merges extra classes and passes props through', () => {
    render(
      <Button type="submit" className="w-full" aria-label="Go">
        Go
      </Button>
    );
    const el = screen.getByRole('button', { name: 'Go' });
    expect(el.getAttribute('type')).toBe('submit');
    expect(el.className).toContain('w-full');
  });
});
