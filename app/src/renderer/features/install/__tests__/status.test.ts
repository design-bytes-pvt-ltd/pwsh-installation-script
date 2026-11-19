import { describe, expect, test } from 'vitest';
import { resultTone, stepLabel, stepTone, summaryTitle } from '../status';

describe('install status', () => {
  test('step labels and tones', () => {
    expect(stepLabel({ status: 'running', detail: 'Downloading' })).toBe('running: Downloading');
    expect(stepLabel({ status: 'pending' })).toBe('pending');
    expect(stepTone({ status: 'pending' })).toBe('neutral');
    expect(stepTone({ status: 'skipped' })).toBe('neutral');
    expect(stepTone({ status: 'failed' })).toBe('failed');
  });

  test('result tones', () => {
    expect(resultTone('FAILED: exit 1')).toBe('failed');
    expect(resultTone('cancelled')).toBe('cancelled');
    expect(resultTone('skipped')).toBe('neutral');
    expect(resultTone('done')).toBe('done');
    expect(resultTone('already installed')).toBe('done');
  });

  test('summary titles', () => {
    const base = { type: 'summary' as const, results: {}, notes: [] };
    expect(summaryTitle({ ...base, exitCode: 0, cancelled: false })).toBe('Setup Complete');
    expect(summaryTitle({ ...base, exitCode: 1, cancelled: false })).toBe('Setup Finished with Errors');
    expect(summaryTitle({ ...base, exitCode: 1, cancelled: true })).toBe('Setup Cancelled');
  });
});
