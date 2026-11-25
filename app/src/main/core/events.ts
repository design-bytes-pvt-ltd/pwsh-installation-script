import type { InstallEvent, StepName } from '../../shared/types';
import type { DownloadProgress } from './downloader';
import { formatBytes, formatElapsed, formatEta } from './format';
import type { NetworkRetryEvent } from './network';

/** A timestamped log event. `output: true` marks a line printed by an external command. */
export function logEvent(message: string, level: 'info' | 'warn' | 'error' = 'info', output = false): InstallEvent {
  return output
    ? { type: 'log', level, message, timestamp: new Date().toISOString(), output: true }
    : { type: 'log', level, message, timestamp: new Date().toISOString() };
}

/** "Downloading Docker.dmg: 312 MB of 610 MB · 2.1 MB/s · about 2 min left" */
export function downloadLabel(label: string, p: DownloadProgress): string {
  const parts = [p.total ? `${label}: ${formatBytes(p.completed)} of ${formatBytes(p.total)}` : `${label}: ${formatBytes(p.completed)}`];
  if (p.bytesPerSec) parts.push(`${formatBytes(p.bytesPerSec)}/s`);
  if (p.etaSec != null) parts.push(formatEta(p.etaSec));
  return parts.join(' · ');
}

/** An onProgress callback for downloadFile that reports the download as a progress event. */
export function downloadProgress(emit: (event: InstallEvent) => void, step: StepName, label: string): (p: DownloadProgress) => void {
  return (p) =>
    emit({
      type: 'progress',
      step,
      label: downloadLabel(label, p),
      completed: p.completed,
      total: p.total ?? undefined,
      percent: p.percent ?? undefined,
    });
}

function firstLine(err: unknown): string {
  return String((err as Error)?.message ?? err).split('\n')[0];
}

/**
 * Reports withNetworkRetry events for one step: a log line when the connection drops, comes back,
 * or a retry starts, and a ticking "Waiting for the internet connection" label meanwhile.
 */
export function networkReporter(emit: (event: InstallEvent) => void, step: StepName, what: string): (e: NetworkRetryEvent) => void {
  const waiting = (elapsedMs: number) =>
    emit({
      type: 'progress',
      step,
      label: `Waiting for the internet connection... ${formatElapsed(elapsedMs)} (${what} continues automatically)`,
    });
  return (e) => {
    switch (e.type) {
      case 'offline':
        emit(logEvent(`No internet connection while ${what} (${firstLine(e.error)}). Waiting for it to come back...`, 'warn'));
        waiting(0);
        return;
      case 'waiting':
        waiting(e.elapsedMs);
        return;
      case 'online':
        emit(logEvent(`The internet connection is back after ${formatElapsed(e.waitedMs)}; continuing ${what}.`));
        return;
      case 'retry':
        emit(logEvent(`${firstLine(e.error)} Trying again (${e.attempt} of ${e.maxAttempts})...`, 'warn'));
        return;
    }
  };
}

/** Logs once that a download is slow, with how long it will take. */
export function slowDownloadNote(emit: (event: InstallEvent) => void, what: string): (bytesPerSec: number, etaSec: number | null) => void {
  return (bytesPerSec, etaSec) =>
    emit(
      logEvent(
        `The connection is slow (${formatBytes(bytesPerSec)}/s)${etaSec != null ? `; ${what} will take ${formatEta(etaSec).replace(/ left$/, '')}` : ''}.`,
        'warn'
      )
    );
}

/** Progress, connection and slow-speed reporting for one download, e.g. ("Docker", "Docker.dmg"). */
export function downloadReporting(emit: (event: InstallEvent) => void, step: StepName, file: string) {
  return {
    onProgress: downloadProgress(emit, step, `Downloading ${file}`),
    onNetwork: networkReporter(emit, step, `downloading ${file}`),
    onSlow: slowDownloadNote(emit, `downloading ${file}`),
  };
}
