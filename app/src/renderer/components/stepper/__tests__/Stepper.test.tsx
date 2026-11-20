// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Stepper, type StepperStep } from '../Stepper';

afterEach(cleanup);

const steps: StepperStep[] = [
  { id: 'get-ready', title: 'Get ready', description: 'Check your PC' },
  { id: 'install', title: 'Install', description: 'Set up the app' },
  { id: 'finish', title: 'Finish', description: 'Open and go' },
];

const items = () => screen.getAllByRole('listitem');

describe('Stepper', () => {
  test('marks earlier steps complete, the current one active, later ones upcoming', () => {
    render(<Stepper steps={steps} value="install" />);
    expect(items().map((li) => li.dataset.status)).toEqual(['complete', 'active', 'upcoming']);
    expect(items()[1].getAttribute('aria-current')).toBe('step');
    expect(items()[0].getAttribute('aria-current')).toBeNull();
  });

  test('shows a check for complete steps and numbers for the rest', () => {
    render(<Stepper steps={steps} value="install" />);
    expect(items()[0].textContent).toContain('Completed:');
    expect(items()[0].textContent).not.toContain('1');
    expect(items()[1].textContent).toContain('2');
    expect(items()[2].textContent).toContain('3');
  });

  test('renders titles and descriptions', () => {
    render(<Stepper steps={steps} value="get-ready" />);
    expect(screen.getByText('Install')).toBeTruthy();
    expect(screen.getByText('Open and go')).toBeTruthy();
  });

  test('connectors: green after a complete step, grey otherwise, none inside the active card', () => {
    render(<Stepper steps={steps} value="install" />);
    const connectors = (li: HTMLElement) =>
      Array.from(li.querySelectorAll<HTMLElement>('[data-slot="stepper-connector"]'));

    const [first, active, last] = items();
    expect(connectors(first)).toHaveLength(1);
    expect(connectors(first)[0].className).toContain('bg-stepper-connector-complete');
    expect(connectors(active)).toHaveLength(0);
    expect(connectors(last)).toHaveLength(1);
    expect(connectors(last)[0].className).toContain('bg-sidebar-foreground/28');
  });

  test('follows the step order when value moves', () => {
    const { rerender } = render(<Stepper steps={steps} value="get-ready" />);
    expect(items().map((li) => li.dataset.status)).toEqual(['active', 'upcoming', 'upcoming']);
    rerender(<Stepper steps={steps} value="finish" />);
    expect(items().map((li) => li.dataset.status)).toEqual(['complete', 'complete', 'active']);
  });

  test('an unknown value shows every step as upcoming', () => {
    render(<Stepper steps={steps} value="nope" />);
    expect(items().every((li) => li.dataset.status === 'upcoming')).toBe(true);
    expect(items().some((li) => li.getAttribute('aria-current'))).toBe(false);
  });
});
