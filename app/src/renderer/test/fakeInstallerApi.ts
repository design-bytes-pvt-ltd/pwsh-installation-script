import { vi } from 'vitest';
import type { InstallerApi } from '../../shared/api';
import type { InstallEvent, ModelRow, ProbeResult } from '../../shared/types';

/** Test-only helpers: a fake preload bridge and sample probe data. */

export const modelRow = (name: string, extra: Partial<ModelRow> = {}): ModelRow => ({
  name,
  description: `${name} model`,
  sizeGB: 2,
  minMemoryGB: null,
  tier: 'recommended',
  installed: false,
  isDefault: false,
  ...extra,
});

export const sampleProbe: ProbeResult = {
  os: 'linux',
  arch: 'amd64',
  budget: { budgetGB: 12, ramGB: 16, source: '16 GB RAM' },
  disk: { path: '/home/u', freeGB: 120, requiredGB: 60 },
  ollamaInstalled: true,
  ollamaPath: '/usr/bin/ollama',
  dockerInstalled: 'none',
  devContainer: 'missing',
  gpu: null,
  models: [
    modelRow('llama3', { isDefault: true, sizeGB: 4.7 }),
    modelRow('tiny', { sizeGB: 0.5 }),
    modelRow('giant', { tier: 'too large', sizeGB: 40 }),
  ],
};

export type FakeApi = { [K in keyof InstallerApi]: ReturnType<typeof vi.fn> };

export interface FakeInstaller {
  api: FakeApi;
  /** Sends an event as if it came from the main process. */
  emit: (event: InstallEvent) => void;
  /** Resolves the pending startInstall() call (the run ends). */
  finishInstall: () => void;
}

/** Installs a fake `window.installerApi` and returns handles to drive it. */
export function installFakeInstallerApi(probe: ProbeResult = sampleProbe): FakeInstaller {
  const listeners = new Set<(e: InstallEvent) => void>();
  let finish = () => {};
  const api: FakeApi = {
    probe: vi.fn().mockResolvedValue(probe),
    startInstall: vi.fn(() => new Promise<void>((resolve) => (finish = resolve))),
    cancelInstall: vi.fn().mockResolvedValue(undefined),
    showLog: vi.fn().mockResolvedValue(undefined),
    copyErrorReport: vi.fn().mockResolvedValue(true),
    reportError: vi.fn().mockResolvedValue(undefined),
    launchApp: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn((cb: (e: InstallEvent) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
  };
  window.installerApi = api as unknown as InstallerApi;
  return {
    api,
    emit: (event) => listeners.forEach((cb) => cb(event)),
    finishInstall: () => finish(),
  };
}

/** Radix measures elements; jsdom has no ResizeObserver. */
export function polyfillResizeObserver(): void {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
