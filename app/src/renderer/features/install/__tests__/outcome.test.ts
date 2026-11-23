import { describe, expect, test } from 'vitest';
import { initialState, type InstallState, type SummaryEvent } from '@/store';
import { errorCode, failedStepPhrase, installOutcome } from '../outcome';

const summary = (extra: Partial<SummaryEvent> = {}): SummaryEvent => ({
  type: 'summary',
  results: {},
  notes: [],
  exitCode: 1,
  cancelled: false,
  failures: [],
  ...extra,
});
const install = (extra: Partial<InstallState>): InstallState => ({ ...initialState.install, ...extra });

describe('installOutcome', () => {
  test('is null before, during and after a successful run', () => {
    expect(installOutcome(install({}))).toBeNull();
    expect(installOutcome(install({ running: true, summary: summary() }))).toBeNull();
    expect(installOutcome(install({ summary: summary({ exitCode: 0 }) }))).toBeNull();
  });

  test('reports a cancelled run, even though its exit code is 1', () => {
    expect(installOutcome(install({ summary: summary({ cancelled: true }) }))).toBe('cancelled');
  });

  test('reports a failed run or one that could not start', () => {
    expect(installOutcome(install({ summary: summary() }))).toBe('failed');
    expect(installOutcome(install({ startError: 'busy' }))).toBe('failed');
  });
});

describe('errorCode', () => {
  test('combines the step and the hint id', () => {
    expect(errorCode({ step: 'Models: llama3', summary: 'x', hintId: 'network' })).toBe('EB-MODELS-NETWORK');
    expect(errorCode({ step: 'Docker', summary: 'x', hintId: 'docker-unreachable' })).toBe('EB-DOCKER-DOCKER-UNREACHABLE');
  });

  test('falls back when there is no hint or no failure', () => {
    expect(errorCode({ step: 'Containers', summary: 'x' })).toBe('EB-CONTAINERS-UNKNOWN');
    expect(errorCode(undefined)).toBe('EB-START-FAILED');
  });
});

describe('failedStepPhrase', () => {
  test('names the failed step', () => {
    expect(failedStepPhrase({ step: 'Models: llama3', summary: 'x' })).toBe('setting up the AI model');
    expect(failedStepPhrase({ step: 'Ollama', summary: 'x' })).toBe('installing Ollama');
    expect(failedStepPhrase({ step: 'Something else', summary: 'x' })).toBe('setting up Enterprise Brain');
    expect(failedStepPhrase(undefined)).toBe('setting up Enterprise Brain');
  });
});
