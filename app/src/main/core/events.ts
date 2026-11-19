import type { InstallEvent, StepName } from '../../shared/types';
import type { DownloadProgress } from './downloader';

/** A timestamped log event. `output: true` marks a line printed by an external command. */
export function logEvent(message: string, level: 'info' | 'warn' | 'error' = 'info', output = false): InstallEvent {
  return output
    ? { type: 'log', level, message, timestamp: new Date().toISOString(), output: true }
    : { type: 'log', level, message, timestamp: new Date().toISOString() };
}

/** An onProgress callback for downloadFile that reports the download as a progress event. */
export function downloadProgress(emit: (event: InstallEvent) => void, step: StepName, label: string): (p: DownloadProgress) => void {
  return (p) => emit({ type: 'progress', step, label, completed: p.completed, total: p.total ?? undefined, percent: p.percent ?? undefined });
}
