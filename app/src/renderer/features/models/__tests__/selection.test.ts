import { describe, expect, test } from 'vitest';
import type { ModelRow } from '../../../../shared/types';
import { downloadSizeGB, selectionSummary, tierClassName, tooLargeSelected } from '../selection';

const row = (name: string, extra: Partial<ModelRow> = {}): ModelRow => ({
  name,
  description: '',
  sizeGB: 2,
  minMemoryGB: null,
  tier: 'recommended',
  installed: false,
  isDefault: false,
  ...extra,
});

const models = [
  row('small', { sizeGB: 1.5 }),
  row('installed', { sizeGB: 4, installed: true }),
  row('unknown', { sizeGB: null }),
  row('huge', { sizeGB: 40, tier: 'too large' }),
];

describe('model selection', () => {
  test('download size skips installed models and unknown sizes', () => {
    expect(downloadSizeGB(models, ['small', 'installed', 'unknown'])).toBe(1.5);
  });

  test('summary text', () => {
    expect(selectionSummary(models, ['small', 'huge'])).toBe('2 selected (41.5 GB to download)');
    expect(selectionSummary(models, [])).toBe('0 selected (0.0 GB to download)');
  });

  test('finds selected models that are too large', () => {
    expect(tooLargeSelected(models, ['small', 'huge']).map((m) => m.name)).toEqual(['huge']);
    expect(tooLargeSelected(models, ['small'])).toEqual([]);
  });

  test('tier colors', () => {
    expect(tierClassName('recommended')).toBe('text-success');
    expect(tierClassName('may be slow')).toBe('text-warning');
    expect(tierClassName('too large')).toBe('text-muted-foreground');
  });
});
