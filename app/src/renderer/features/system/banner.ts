import type { ProbeResult } from '../../../shared/types';

/** The one-line system summary under the app title. */
export function systemBanner(probe: ProbeResult | null, probeError: string | null): string {
  if (probeError) return `Initialization error: ${probeError}`;
  if (!probe) return 'Detecting hardware and installed tools...';
  const budget = probe.budget
    ? `${probe.budget.source} (recommending up to ${probe.budget.budgetGB} GB)`
    : 'Memory budget unknown';
  return `OS: ${probe.os} (${probe.arch}) | ${budget}`;
}
