// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { overallPercent, SegmentedProgress, type ProgressSegment } from '../SegmentedProgress';

afterEach(cleanup);

const segments: ProgressSegment[] = [
  { id: 'a', label: 'Preparing', value: 100, status: 'complete' },
  { id: 'b', label: 'Copying files', value: 100, status: 'complete' },
  { id: 'c', label: 'AI model', value: 48, status: 'active' },
  { id: 'd', label: 'Finishing', value: 0, status: 'upcoming' },
];

const items = () => screen.getAllByRole('listitem');
const fill = (li: HTMLElement) => li.querySelector<HTMLElement>('[data-slot="segmented-progress-fill"]')!;

describe('SegmentedProgress', () => {
  test('shows the overall percentage as a progressbar under the label', () => {
    render(<SegmentedProgress segments={segments} />);
    expect(screen.getByText('Overall progress')).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Overall progress' });
    expect(bar.textContent).toBe('62%');
    expect(bar.getAttribute('aria-valuenow')).toBe('62');
  });

  test('one bar per segment, filled to its value, with its name and status', () => {
    render(<SegmentedProgress segments={segments} />);
    expect(items().map((li) => li.textContent)).toEqual(['Preparing', 'Copying files', 'AI model', 'Finishing']);
    expect(items().map((li) => li.dataset.status)).toEqual(['complete', 'complete', 'active', 'upcoming']);
    expect(items().map((li) => fill(li).style.width)).toEqual(['100%', '100%', '48%', '0%']);
  });

  test('a failed segment is red', () => {
    render(<SegmentedProgress segments={[{ id: 'x', label: 'Docker', value: 30, status: 'error' }]} />);
    expect(fill(items()[0]).className).toContain('bg-destructive');
  });

  test('takes a custom label and passes div props through', () => {
    render(<SegmentedProgress segments={segments} label="Download" className="mt-4" data-testid="card" />);
    expect(screen.getByRole('progressbar', { name: 'Download' })).toBeTruthy();
    expect(screen.getByTestId('card').className).toContain('mt-4');
  });
});

describe('overallPercent', () => {
  test('averages the segments, clamping each to 0–100', () => {
    expect(overallPercent([])).toBe(0);
    expect(overallPercent(segments)).toBe(62);
    expect(overallPercent([{ ...segments[0], value: 150 }, { ...segments[3], value: -10 }])).toBe(50);
  });
});
