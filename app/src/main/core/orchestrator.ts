import { detectDocker, installDocker } from './docker';
import { ErrorReport, ReportedError, toErrorReport } from './errors';
import { logEvent } from './events';
import { getModelBudget } from './hardware';
import { buildModelRows, getInstalledModels, getOllamaBaseUrl, loadModelCatalog } from './models';
import { getOllamaExe, installOllama, pullModelStream, waitForOllamaServer } from './ollama';
import type { InstallLogger } from './logger';
import { getArch, getTargetOS } from './platform';
import type { InstallEvent, InstallOptions, ProbeResult, StepName } from '../../shared/types';

export async function probeSystem(catalogPath?: string): Promise<ProbeResult> {
  const os = getTargetOS();
  const arch = await getArch(os);
  const budget = await getModelBudget(os);
  const ollamaPath = await getOllamaExe(os);
  const dockerInstalled = await detectDocker(os);
  const catalog = loadModelCatalog(catalogPath);
  const installed = await getInstalledModels(getOllamaBaseUrl(), os);
  const models = buildModelRows(catalog, installed, budget);

  return {
    os,
    arch,
    budget,
    ollamaInstalled: Boolean(ollamaPath),
    ollamaPath,
    dockerInstalled,
    models,
  };
}

/** Pulls each model, continuing past failures. Each failure gets its own report. Returns the names that failed. */
async function pullModels(
  models: string[],
  emit: (event: InstallEvent) => void,
  report: (r: ErrorReport) => void,
  signal?: AbortSignal
): Promise<string[]> {
  const exe = await getOllamaExe();
  if (!exe) throw new Error('Ollama is not installed; cannot pull models.');
  const baseUrl = getOllamaBaseUrl();
  await waitForOllamaServer(exe, baseUrl, emit, signal);

  const failed: string[] = [];
  for (const model of models) {
    if (signal?.aborted) break;
    emit(logEvent(`Pulling ${model}`));
    try {
      await pullModelStream(
        model,
        baseUrl,
        (p) => emit({ type: 'progress', step: 'Models', label: `${model}: ${p.status}`, completed: p.completed, total: p.total, percent: p.percent }),
        signal
      );
      emit(logEvent(`Pulled ${model}`));
    } catch (err) {
      if (signal?.aborted) break;
      report(toErrorReport(err, `Models: ${model}`));
      failed.push(model);
    }
  }
  return failed;
}

export async function runInstall(
  options: InstallOptions,
  emit: (event: InstallEvent) => void,
  signal?: AbortSignal,
  logger?: InstallLogger
): Promise<void> {
  const results: Record<string, string> = {};
  const notes: string[] = [];
  const reports: ErrorReport[] = [];

  const forward = (event: InstallEvent) => {
    if (event.type === 'note') notes.push(event.message);
    logger?.event(event);
    emit(event);
  };

  /** Records a failure: full report in the log file, a short line in the UI log. */
  const report = (r: ErrorReport) => {
    reports.push(r);
    logger?.failure(r);
    emit(logEvent(r.hint ? `${r.step}: ${r.summary} (${r.hint})` : `${r.step}: ${r.summary}`, 'error'));
  };

  /** Runs one step, turning errors into FAILED and an abort into "cancelled". */
  const runStep = async (step: StepName, skip: string | null, action: () => Promise<string>) => {
    if (signal?.aborted) {
      results[step] = 'cancelled';
      forward({ type: 'step', step, status: 'cancelled' });
      return;
    }
    if (skip) {
      results[step] = 'skipped';
      forward({ type: 'step', step, status: 'skipped', detail: skip === 'skipped' ? undefined : skip });
      return;
    }
    forward({ type: 'step', step, status: 'running' });
    try {
      const status = await action();
      if (signal?.aborted) throw new Error('Cancelled');
      results[step] = status;
      forward({ type: 'step', step, status: 'done', detail: status });
    } catch (err) {
      if (signal?.aborted) {
        results[step] = 'cancelled';
        forward({ type: 'step', step, status: 'cancelled' });
        return;
      }
      let msg = (err as Error)?.message ?? String(err);
      if (!(err instanceof ReportedError)) {
        const r = toErrorReport(err, step);
        report(r);
        msg = r.summary;
      }
      results[step] = `FAILED: ${msg}`;
      forward({ type: 'step', step, status: 'failed', detail: msg });
    }
  };

  await runStep('Ollama', options.installOllama ? null : 'skipped', () =>
    installOllama({ dryRun: options.dryRun, signal, emit: forward })
  );

  await runStep('Models', options.models.length === 0 ? 'skipped' : null, async () => {
    if (options.dryRun) {
      forward(logEvent(`[dry-run] Would pull: ${options.models.join(', ')}`));
      return 'would pull';
    }
    const failed = await pullModels(options.models, forward, report, signal);
    if (failed.length > 0) throw new ReportedError(`Failed to pull: ${failed.join(', ')}`);
    return 'pulled';
  });

  await runStep('Docker', options.installDocker ? null : 'skipped', () =>
    installDocker({ dockerEngineOnLinux: options.dockerEngineOnLinux, dryRun: options.dryRun, signal, emit: forward })
  );

  const cancelled = Boolean(signal?.aborted);
  const hasFailures = Object.values(results).some((v) => v.startsWith('FAILED:'));
  forward({
    type: 'summary',
    results,
    notes: Array.from(new Set(notes)),
    exitCode: hasFailures || cancelled ? 1 : 0,
    cancelled,
    logPath: logger?.filePath,
    failures: reports.map((r) => ({ step: r.step, summary: r.summary, hint: r.hint })),
  });
}
