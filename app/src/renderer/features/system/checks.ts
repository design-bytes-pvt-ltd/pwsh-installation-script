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
 * What the Install step would download, for the internet check: Ollama, Docker, the dev container
 * and the recommended model, whichever are missing. A dev container in an unknown state (Docker
 * not running) is left out: it may well be there, and the install can use it offline.
 */
export function downloadsNeeded(probe: ProbeResult): string[] {
  const needed: string[] = [];
  if (!probe.ollamaInstalled) needed.push('Ollama');
  if (probe.dockerInstalled === 'none') needed.push('Docker');
  if (probe.dockerInstalled === 'none' || probe.devContainer === 'missing') needed.push('the dev container');
  const model = recommendedModel(probe.models);
  if (model && !model.installed) needed.push(model.name);
  return needed;
}

/** True when there is no internet but the install has something to download. */
export function offlineBlocked(probe: ProbeResult | null): boolean {
  return Boolean(probe && !probe.network.online && downloadsNeeded(probe).length > 0);
}

/** "A", "A and B", "A, B and C" */
export function joinNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * Where the system requirements check stands, for the Get ready footer.
 * `checking` and `error` keep "Get Started" disabled, as does `blocked` (not enough disk space, or
 * no internet while something still needs downloading).
 */
export type RequirementsStatus =
  | { kind: 'checking' }
  | { kind: 'error'; message: string }
  | { kind: 'blocked'; reason: 'disk' | 'offline'; message: string }
  | { kind: 'ready' };

export function requirementsStatus(probe: ProbeResult | null, probeError: string | null): RequirementsStatus {
  if (probeError) return { kind: 'error', message: `Couldn't check system requirements: ${probeError}` };
  if (!probe) return { kind: 'checking' };
  if (probe.disk && diskTooLow(probe)) {
    const { freeGB, path, requiredGB } = probe.disk;
    return { kind: 'blocked', reason: 'disk', message: `Not enough disk space: ${formatGB(freeGB)} free on ${path}, needs ${requiredGB} GB` };
  }
  if (offlineBlocked(probe)) {
    return { kind: 'blocked', reason: 'offline', message: `No internet connection: needed to download ${joinNames(downloadsNeeded(probe))}` };
  }
  return { kind: 'ready' };
}
