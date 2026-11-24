import type { InstallState } from '@/store';
import type { FailureSummary } from '../../../shared/types';

/** How a finished install ended, when it did not succeed. */
export type InstallOutcome = 'cancelled' | 'failed';

/** `null` while the install runs, after it succeeded, or before it started. */
export function installOutcome(install: InstallState): InstallOutcome | null {
  if (install.running) return null;
  if (install.summary?.cancelled) return 'cancelled';
  if (install.startError !== null) return 'failed';
  if (install.summary && install.summary.exitCode !== 0) return 'failed';
  return null;
}

/** The step a failure belongs to: report steps can carry detail, e.g. "Models: llama3". */
function failureStep(failure: FailureSummary): string {
  return failure.step.split(':')[0].trim();
}

const codePart = (text: string) =>
  text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * A short code for support, built from the failed step and the matched hint:
 * e.g. EB-MODELS-NETWORK, or EB-DOCKER-UNKNOWN when no hint matched. EB-START-FAILED when the
 * install could not start at all.
 */
export function errorCode(failure: FailureSummary | undefined): string {
  if (!failure) return 'EB-START-FAILED';
  return `EB-${codePart(failureStep(failure)) || 'SETUP'}-${codePart(failure.hintId ?? '') || 'UNKNOWN'}`;
}

const STEP_PHRASES: Record<string, string> = {
  Ollama: 'installing Ollama',
  Models: 'setting up the AI model',
  Docker: 'setting up Docker',
  Containers: 'installing the container',
};

/** Completes "Something went wrong while …" for the failed step. */
export function failedStepPhrase(failure: FailureSummary | undefined): string {
  return (failure && STEP_PHRASES[failureStep(failure)]) ?? 'setting up.';
}
