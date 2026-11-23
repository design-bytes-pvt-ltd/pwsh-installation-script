// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { Bot, HardDrive, Monitor, Package } from 'lucide-react';
import { afterEach, describe, expect, test } from 'vitest';
import { RequirementsTable, type Requirement } from '../RequirementsTable';

afterEach(cleanup);

const requirements: Requirement[] = [
  { id: 'os', icon: Monitor, label: 'Windows', status: 'passed' },
  { id: 'disk', icon: HardDrive, label: '60 GB free space', status: 'failed', result: 'Only 20.0 GB free on C:\\' },
  { id: 'model', icon: Bot, label: '8.0 GB for AI models', status: 'warning', result: 'llama3 may run slowly' },
  { id: 'ollama', icon: Package, label: 'Ollama', status: 'info', result: 'Will be installed' },
];

const rows = () => within(screen.getByRole('list', { name: 'System requirements' })).getAllByRole('listitem');

describe('RequirementsTable', () => {
  test('one row per requirement with its name, status and result', () => {
    render(<RequirementsTable requirements={requirements} />);
    expect(rows().map((li) => li.dataset.status)).toEqual(['passed', 'failed', 'warning', 'info']);
    expect(rows().map((li) => li.textContent)).toEqual([
      'WindowsPassed',
      '60 GB free spaceOnly 20.0 GB free on C:\\',
      '8.0 GB for AI modelsllama3 may run slowly',
      'OllamaWill be installed',
    ]);
  });

  test('only a failed row is light red, with its reason in red', () => {
    render(<RequirementsTable requirements={requirements} />);
    expect(rows().map((li) => li.className.includes('bg-destructive-subtle'))).toEqual([false, true, false, false]);
    expect(within(rows()[1]).getByText('Only 20.0 GB free on C:\\').className).toContain('text-requirement-failed');
  });

  test('passed and failed rows fall back to "Passed" / "Failed"', () => {
    render(<RequirementsTable requirements={[{ ...requirements[1], result: undefined }, { ...requirements[0], result: 'Installed' }]} />);
    expect(within(rows()[0]).getByText('Failed')).toBeTruthy();
    expect(within(rows()[1]).getByText('Installed')).toBeTruthy();
  });
});
