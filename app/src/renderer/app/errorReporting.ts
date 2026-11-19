import { errorMessage } from '@/lib/format';
import { installerApi } from '@/services/installerApi';

export interface RendererErrorReport {
  message: string;
  stack?: string;
  source?: string;
}

/** Sends a renderer error to the main process so it lands in the log file. Never throws. */
export function reportRendererError(report: RendererErrorReport): void {
  try {
    void installerApi.reportError(report).catch(() => {});
  } catch {
    // The bridge itself is unavailable; there is nowhere left to report to.
  }
}

/** Forwards uncaught errors and unhandled promise rejections. Call once, before rendering. */
export function installGlobalErrorReporting(): void {
  window.addEventListener('error', (e) => {
    reportRendererError({
      message: e.message || String(e.error),
      stack: e.error instanceof Error ? e.error.stack : undefined,
      source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason: unknown = e.reason;
    reportRendererError({
      message: errorMessage(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}
