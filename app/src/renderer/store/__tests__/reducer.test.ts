import { describe, expect, test } from 'vitest';
import type { ModelRow, ProbeResult } from '../../../shared/types';
import { initialState, reducer, type AppState } from '../reducer';

const model = (name: string, isDefault: boolean): ModelRow => ({
  name,
  description: '',
  sizeGB: 1,
  minMemoryGB: null,
  tier: 'recommended',
  installed: false,
  isDefault,
});

const probe: ProbeResult = {
  os: 'linux',
  arch: 'amd64',
  budget: null,
  disk: null,
  ollamaInstalled: false,
  ollamaPath: null,
  dockerInstalled: 'none',
  devContainer: 'missing',
  network: { online: true, unreachable: [] },
  gpu: null,
  models: [model('a', true), model('b', false), model('c', true)],
};

const loaded = reducer(initialState, { type: 'probeLoaded', probe });

describe('probe', () => {
  test('loading selects the default models', () => {
    expect(loaded.selectedModels).toEqual(['a', 'c']);
    expect(loaded.probeError).toBeNull();
  });

  test('a failure keeps the previous data', () => {
    const failed = reducer(loaded, { type: 'probeFailed', message: 'boom' });
    expect(failed.probe).toBe(probe);
    expect(failed.probeError).toBe('boom');
    expect(reducer(failed, { type: 'probeLoaded', probe }).probeError).toBeNull();
    expect(reducer(failed, { type: 'probeStarted' }).probeError).toBeNull();
  });
});

describe('selection', () => {
  test('toggle, clear, reset', () => {
    let s: AppState = reducer(loaded, { type: 'modelToggled', name: 'b', selected: true });
    expect(s.selectedModels).toEqual(['a', 'c', 'b']);
    s = reducer(s, { type: 'modelToggled', name: 'a', selected: false });
    expect(s.selectedModels).toEqual(['c', 'b']);
    s = reducer(s, { type: 'modelToggled', name: 'b', selected: true });
    expect(s.selectedModels).toEqual(['c', 'b']);
    expect(reducer(s, { type: 'selectionCleared' }).selectedModels).toEqual([]);
    expect(reducer(s, { type: 'selectionReset' }).selectedModels).toEqual(['a', 'c']);
  });
});

describe('install lifecycle', () => {
  const started = reducer(
    { ...loaded, install: { ...loaded.install, logLines: ['old\n'], percent: 50 } },
    { type: 'installStarting' }
  );

  test('starting resets the previous run and shows progress', () => {
    expect(started.screen).toBe('progress');
    expect(started.install.running).toBe(true);
    expect(started.install.logLines).toEqual([]);
    expect(started.install.percent).toBe(0);
    expect(started.install.progressLabel).toBe('Starting setup...');
    expect(started.install.steps.Docker).toEqual({ status: 'pending' });
    expect(started.install.steps.Containers).toEqual({ status: 'pending' });
  });

  test('events update steps, progress and logs', () => {
    let s = reducer(started, { type: 'installEvent', event: { type: 'step', step: 'Models', status: 'running', detail: 'llama3' } });
    s = reducer(s, { type: 'installEvent', event: { type: 'progress', step: 'Models', label: 'llama3: pulling', percent: 40 } });
    s = reducer(s, { type: 'installEvent', event: { type: 'progress', step: 'Models', label: 'llama3: verifying' } });
    s = reducer(s, { type: 'installEvent', event: { type: 'log', level: 'warn', message: 'slow mirror', timestamp: 't' } });
    s = reducer(s, { type: 'installEvent', event: { type: 'note', message: 'ignored' } });
    expect(s.install.steps.Models).toEqual({ status: 'running', detail: 'llama3', percent: 40 });
    expect(s.install.steps.Ollama).toEqual({ status: 'pending' });
    expect(s.install.progressLabel).toBe('Models: llama3: verifying');
    expect(s.install.percent).toBe(40);

    // A later status change keeps the step's percentage.
    s = reducer(s, { type: 'installEvent', event: { type: 'step', step: 'Models', status: 'failed', detail: 'timeout' } });
    expect(s.install.steps.Models).toEqual({ status: 'failed', detail: 'timeout', percent: 40 });
    expect(s.install.logLines).toEqual(['[warn] slow mirror\n']);
  });

  test('cancel, failure to start, settle and summary', () => {
    const cancelling = reducer(started, { type: 'cancelRequested' });
    expect(cancelling.install.cancelling).toBe(true);
    expect(cancelling.install.progressLabel).toBe('Cancelling...');

    expect(reducer(started, { type: 'installStartFailed', message: 'busy' }).install.progressLabel).toBe('Could not start: busy');
    expect(reducer(started, { type: 'installSettled' }).install.running).toBe(false);

    const summary = { type: 'summary' as const, results: { Ollama: 'done' }, notes: [], exitCode: 0, cancelled: false };
    const done = reducer(started, { type: 'installEvent', event: summary });
    expect(done.screen).toBe('summary');
    expect(done.install.summary).toBe(summary);
    expect(reducer(done, { type: 'backToStart' }).screen).toBe('configure');
  });
});
