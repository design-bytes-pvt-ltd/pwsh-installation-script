import { describe, expect, test } from 'vitest';
import { modelRow, sampleProbe } from '@/test/fakeInstallerApi';
import { diskTooLow, everythingInstalled, requirementsStatus } from '../checks';

const lowDisk = { ...sampleProbe, disk: { path: 'C:\\', freeGB: 20, requiredGB: 60 } };

describe('diskTooLow', () => {
  test('blocks only when measured free space is below what is needed', () => {
    expect(diskTooLow(sampleProbe)).toBe(false);
    expect(diskTooLow({ ...sampleProbe, disk: { path: 'C:\\', freeGB: 59.9, requiredGB: 60 } })).toBe(true);
    expect(diskTooLow({ ...sampleProbe, disk: null })).toBe(false);
    expect(diskTooLow(null)).toBe(false);
  });
});

describe('requirementsStatus', () => {
  test('is checking until the probe arrives, then ready', () => {
    expect(requirementsStatus(null, null)).toEqual({ kind: 'checking' });
    expect(requirementsStatus(sampleProbe, null)).toEqual({ kind: 'ready' });
  });

  test('unknown disk space does not block', () => {
    expect(requirementsStatus({ ...sampleProbe, disk: null }, null)).toEqual({ kind: 'ready' });
  });

  test('blocks on low disk space, saying how much is free and needed', () => {
    expect(requirementsStatus(lowDisk, null)).toEqual({
      kind: 'blocked',
      message: 'Not enough disk space: 20.0 GB free on C:\\, needs 60 GB',
    });
  });

  test('reports a failed probe', () => {
    expect(requirementsStatus(null, 'boom')).toEqual({ kind: 'error', message: "Couldn't check system requirements: boom" });
  });
});

describe('everythingInstalled', () => {
  const allThere = {
    ...sampleProbe,
    dockerInstalled: 'desktop' as const,
    devContainer: 'running' as const,
    models: [modelRow('llama3', { isDefault: true, installed: true }), modelRow('tiny')],
  };

  test('is true only when Ollama, Docker, the running dev container and the recommended model are all there', () => {
    expect(everythingInstalled(allThere)).toBe(true);
    expect(everythingInstalled({ ...allThere, ollamaInstalled: false })).toBe(false);
    expect(everythingInstalled({ ...allThere, dockerInstalled: 'none' })).toBe(false);
    expect(everythingInstalled({ ...allThere, devContainer: 'stopped' })).toBe(false);
    expect(everythingInstalled({ ...allThere, devContainer: 'missing' })).toBe(false);
    expect(everythingInstalled({ ...allThere, devContainer: 'unknown' })).toBe(false);
    expect(everythingInstalled({ ...allThere, models: [modelRow('llama3', { isDefault: true })] })).toBe(false);
    expect(everythingInstalled(null)).toBe(false);
  });

  test('does not wait for a model when none is recommended', () => {
    expect(everythingInstalled({ ...allThere, models: [modelRow('tiny')] })).toBe(true);
  });
});
