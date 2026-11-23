import { describe, expect, test } from 'vitest';
import type { ProbeResult } from '../../../../shared/types';
import { modelRow, sampleProbe } from '@/test/fakeInstallerApi';
import { requirementResults } from '../requirements';

/** id → [label, status, result] for easy comparison. */
const table = (probe: ProbeResult | null, error: string | null = null) =>
  Object.fromEntries(requirementResults(probe, error).map(({ id, label, status, result }) => [id, [label, status, result]]));

describe('requirementResults', () => {
  test('lists every system check, in order', () => {
    expect(requirementResults(sampleProbe, null).map((r) => r.id)).toEqual(['os', 'cpu', 'ram', 'gpu', 'model-memory', 'disk']);
    expect(table({ ...sampleProbe, ollamaInstalled: false })).toEqual({
      os: ['Linux', 'passed', undefined],
      cpu: ['64-bit Intel or AMD processor', 'passed', undefined],
      ram: ['16.0 GB memory (RAM)', 'passed', undefined],
      gpu: ['Graphics card', 'info', 'None found, AI runs on the processor'],
      'model-memory': ['12.0 GB for AI models', 'passed', undefined],
      disk: ['60 GB free space', 'passed', undefined],
    });
  });

  test('leaves out what is already installed', () => {
    const t = table({ ...sampleProbe, dockerInstalled: 'desktop', devContainer: 'running' });
    expect(['ollama', 'docker', 'dev-container'].filter((id) => id in t)).toEqual([]);
  });

  test('hardware: ARM, graphics cards and Apple silicon', () => {
    expect(table({ ...sampleProbe, arch: 'arm64' }).cpu).toEqual(['64-bit ARM processor', 'passed', undefined]);
    expect(table({ ...sampleProbe, gpu: { vendor: 'NVIDIA', vramGB: 8 } }).gpu).toEqual(['NVIDIA graphics card, 8.0 GB', 'passed', undefined]);
    expect(table({ ...sampleProbe, os: 'macos', arch: 'arm64' }).gpu).toEqual(['Apple silicon graphics', 'passed', 'Shares memory']);
  });

  test('warns when the AI model will be slow, without failing', () => {
    const withModel = (tier: 'may be slow' | 'too large') => ({ ...sampleProbe, models: [modelRow('llama3', { isDefault: true, tier })] });
    expect(table(withModel('may be slow'))['model-memory']).toEqual(['12.0 GB for AI models', 'warning', 'llama3 may run slowly']);
    expect(table(withModel('too large'))['model-memory']).toEqual(['12.0 GB for AI models', 'warning', 'llama3 needs more, it will be very slow']);
  });

  test('fails free space with how much there is', () => {
    const lowDisk = { ...sampleProbe, disk: { path: 'C:\\', freeGB: 20, requiredGB: 60 } };
    expect(table(lowDisk).disk).toEqual(['60 GB free space', 'failed', 'Needs 60.0 GB · found 20.0 GB']);
  });

  test("what couldn't be measured is info, not a failure", () => {
    const t = table({ ...sampleProbe, disk: null, budget: null });
    expect(t.disk).toEqual(['Free space', 'info', "Couldn't measure"]);
    expect(t.ram).toEqual(['Memory (RAM)', 'info', "Couldn't measure"]);
    expect(t['model-memory']).toEqual(['Memory for AI models', 'info', "Couldn't measure"]);
  });

  test('a failed check is a single failed row with the error, even with older probe data', () => {
    const failed = { check: ['System check', 'failed', 'no hardware info'] };
    expect(table(null, 'no hardware info')).toEqual(failed);
    expect(table(sampleProbe, 'no hardware info')).toEqual(failed);
  });
});
