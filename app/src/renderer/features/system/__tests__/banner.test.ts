import { describe, expect, test } from 'vitest';
import type { ProbeResult } from '../../../../shared/types';
import { systemBanner } from '../banner';

const probe: ProbeResult = {
  os: 'macos',
  arch: 'arm64',
  budget: { budgetGB: 12, ramGB: 16, source: '16 GB unified memory' },
  disk: null,
  ollamaInstalled: false,
  ollamaPath: null,
  dockerInstalled: 'none',
  devContainer: 'missing',
  network: { online: true, unreachable: [] },
  gpu: null,
  models: [],
};

describe('systemBanner', () => {
  test('while probing', () => {
    expect(systemBanner(null, null)).toBe('Detecting hardware and installed tools...');
  });

  test('with a memory budget', () => {
    expect(systemBanner(probe, null)).toBe('OS: macos (arm64) | 16 GB unified memory (recommending up to 12 GB)');
  });

  test('without a memory budget', () => {
    expect(systemBanner({ ...probe, budget: null }, null)).toBe('OS: macos (arm64) | Memory budget unknown');
  });

  test('an error wins over older data', () => {
    expect(systemBanner(probe, 'boom')).toBe('Initialization error: boom');
  });
});
