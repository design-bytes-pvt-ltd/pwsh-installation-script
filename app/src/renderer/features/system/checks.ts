import { recommendedModel } from '@/features/models';
import { formatGB } from '@/lib/format';
import type { ProbeResult } from '../../../shared/types';

/** True when free space was measured and is below what setup needs. Unknown space does not block. */
export function diskTooLow(probe: ProbeResult | null): boolean {
  const disk = probe?.disk;
  return Boolean(disk && disk.freeGB < disk.requiredGB);
}

/**
 * True when the probe found everything the Install step would set up: Ollama, Docker, the running
 * dev container, and the recommended model (when there is none, the install downloads no model either).
 */
export function everythingInstalled(probe: ProbeResult | null): boolean {
  if (!probe || !probe.ollamaInstalled || probe.dockerInstalled === 'none') return false;
  if (probe.devContainer !== 'running') return false;
  const model = recommendedModel(probe.models);
  return model === null || model.installed;
}

/**
 * Where the system requirements check stands, for the Get ready footer.
 * `checking` and `error` keep "Get Started" disabled, as does `blocked` (not enough disk space).
 */
export type RequirementsStatus =
  | { kind: 'checking' }
  | { kind: 'error'; message: string }
  | { kind: 'blocked'; message: string }
  | { kind: 'ready' };

export function requirementsStatus(probe: ProbeResult | null, probeError: string | null): RequirementsStatus {
  if (probeError) return { kind: 'error', message: `Couldn't check system requirements: ${probeError}` };
  if (!probe) return { kind: 'checking' };
  if (probe.disk && diskTooLow(probe)) {
    const { freeGB, path, requiredGB } = probe.disk;
    return { kind: 'blocked', message: `Not enough disk space: ${formatGB(freeGB)} free on ${path}, needs ${requiredGB} GB` };
  }
  return { kind: 'ready' };
}
