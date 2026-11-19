import type { SummaryEvent, StepState } from '@/store';

export type StatusTone = 'neutral' | 'running' | 'done' | 'failed' | 'cancelled';

/** Badge text for a live step: "running: Downloading" or just "running". */
export function stepLabel(step: StepState): string {
  return step.detail ? `${step.status}: ${step.detail}` : step.status;
}

export function stepTone(step: StepState): StatusTone {
  switch (step.status) {
    case 'running':
    case 'done':
    case 'failed':
    case 'cancelled':
      return step.status;
    default:
      return 'neutral';
  }
}

/** Tone for a final result string from the summary event ("done", "skipped", "FAILED: ..."). */
export function resultTone(value: string): StatusTone {
  if (value.startsWith('FAILED:')) return 'failed';
  if (value === 'cancelled') return 'cancelled';
  if (value === 'skipped') return 'neutral';
  return 'done';
}

export function summaryTitle(summary: SummaryEvent): string {
  if (summary.cancelled) return 'Setup Cancelled';
  return summary.exitCode === 0 ? 'Setup Complete' : 'Setup Finished with Errors';
}
