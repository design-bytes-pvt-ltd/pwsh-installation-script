import { describe, expect, test } from 'vitest';
import { progressCaption, resultTone, stepLabel, stepSegment, stepTone, summaryTitle } from '../status';

describe('install status', () => {
  test('step labels and tones', () => {
    expect(stepLabel({ status: 'running', detail: 'Downloading' })).toBe('running: Downloading');
    expect(stepLabel({ status: 'pending' })).toBe('pending');
    expect(stepTone({ status: 'pending' })).toBe('neutral');
    expect(stepTone({ status: 'skipped' })).toBe('neutral');
    expect(stepTone({ status: 'failed' })).toBe('failed');
  });

  test('progress segments', () => {
    expect(stepSegment({ status: 'pending' })).toEqual({ status: 'upcoming', value: 0 });
    expect(stepSegment({ status: 'running' })).toEqual({ status: 'active', value: 0 });
    expect(stepSegment({ status: 'running', percent: 40 })).toEqual({ status: 'active', value: 40 });
    expect(stepSegment({ status: 'done', percent: 40 })).toEqual({ status: 'complete', value: 100 });
    expect(stepSegment({ status: 'skipped' })).toEqual({ status: 'complete', value: 100 });
    expect(stepSegment({ status: 'failed', percent: 30 })).toEqual({ status: 'error', value: 30 });
    expect(stepSegment({ status: 'cancelled', percent: 30 })).toEqual({ status: 'upcoming', value: 30 });
  });

  test('progress caption drops the step prefix', () => {
    expect(progressCaption('Containers: Downloading the dev container: 312 MB of 3.87 GB')).toBe(
      'Downloading the dev container: 312 MB of 3.87 GB'
    );
    expect(progressCaption('Models: llama3: pulling')).toBe('llama3: pulling');
    expect(progressCaption('Starting setup...')).toBe('Starting setup...');
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
