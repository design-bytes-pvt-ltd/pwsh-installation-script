// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Typography } from '../Typography';

afterEach(cleanup);

describe('Typography', () => {
  test('defaults to body text in the primary font', () => {
    render(<Typography>world</Typography>);
    const el = screen.getByText('world');
    expect(el.tagName).toBe('P');
    expect(el.className).toContain('font-sans');
    expect(el.className).toContain('text-base');
  });

  test('uses the semantic element for a variant', () => {
    render(<Typography variant="h1">Title</Typography>);
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeTruthy();
  });

  test('secondary font, muted tone, custom element and extra classes', () => {
    render(
      <Typography variant="caption" font="secondary" tone="muted" as="code" className="uppercase">
        v1.0.0
      </Typography>
    );
    const el = screen.getByText('v1.0.0');
    expect(el.tagName).toBe('CODE');
    expect(el.className).toContain('font-mono');
    expect(el.className).toContain('text-muted-foreground');
    expect(el.className).toContain('uppercase');
  });
});
