import { detectDevContainer, startContainers } from './containers';
import { detectDocker, installDocker } from './docker';
import { ErrorReport, ReportedError, toErrorReport } from './errors';
import { logEvent } from './events';
import { computeModelBudget, getDiskInfo, getGpuMemoryGB, getSystemMemoryGB } from './hardware';
import { buildModelRows, getInstalledModels, getOllamaBaseUrl, loadModelCatalog, normalizeModelKey } from './models';
import { getOllamaExe, installOllama, pullModelStream, waitForOllamaServer } from './ollama';
import type { InstallLogger } from './logger';
import { getArch, getTargetOS } from './platform';
import type { InstallEvent, InstallOptions, ProbeResult, StepName } from '../../shared/types';

/** Checks everything at once: the detections that don't depend on each other run in parallel. */
export async function probeSystem(catalogPath?: string): Promise<ProbeResult> {
  const os = getTargetOS();
  const [arch, gpu, disk, ollamaPath, dockerInstalled, installed] = await Promise.all([
    getArch(os),
    getGpuMemoryGB(os),
    getDiskInfo(os),
    getOllamaExe(os),
    detectDocker(os),
    getInstalledModels(getOllamaBaseUrl(), os),
  ]);
  // These need a result from above.
  const devContainer = await detectDevContainer(dockerInstalled, os);
  const budget = computeModelBudget(getSystemMemoryGB(), gpu, os, arch);
  const models = buildModelRows(loadModelCatalog(catalogPath), installed, budget);

  return {
    os,
    arch,
    budget,
    gpu,
    disk,
    ollamaInstalled: Boolean(ollamaPath),
    ollamaPath,
    dockerInstalled,
    devContainer,
    models,
  };
}

export interface PullResult {
  pulled: string[];
  /** Already downloaded, so not pulled again. */
  skipped: string[];
  failed: string[];
}

/**
 * Pulls each model that is not downloaded yet, continuing past failures. Each failure gets its own
 * report. Expects the Ollama server at `baseUrl` to be running.
 */
export async function pullMissingModels(
  models: string[],
  baseUrl: string,
  emit: (event: InstallEvent) => void,
  report: (r: ErrorReport) => void,
  signal?: AbortSignal
): Promise<PullResult> {
  // Checked here rather than trusting the probe, which may predate this run.
  const installed = await getInstalledModels(baseUrl);
  const result: PullResult = { pulled: [], skipped: [], failed: [] };
  for (const model of models) {
    if (signal?.aborted) break;
    if (installed.has(normalizeModelKey(model))) {
      emit(logEvent(`${model} is already downloaded; not pulling it again`));
      result.skipped.push(model);
      continue;
    }
    emit(logEvent(`Pulling ${model}`));
    try {
      await pullModelStream(
        model,
        baseUrl,
        (p) => emit({ type: 'progress', step: 'Models', label: `${model}: ${p.status}`, completed: p.completed, total: p.total, percent: p.percent }),
        signal
      );
      emit(logEvent(`Pulled ${model}`));
      result.pulled.push(model);
    } catch (err) {
      if (signal?.aborted) break;
      report(toErrorReport(err, `Models: ${model}`));
      result.failed.push(model);
    }
  }
  return result;
}

/** Files bundled with the app that the install reads. Resolved by the main process, never the renderer. */
export interface InstallResources {
  /** docker-compose.yml for the dev containers. */
  composePath: string;
  /** Candidate ghcr.io credential files, tried in order. */
  credentialFiles: string[];
}

export async function runInstall(
  options: InstallOptions,
  emit: (event: InstallEvent) => void,
  signal?: AbortSignal,
  logger?: InstallLogger,
  resources?: InstallResources
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
    const exe = await getOllamaExe();
    if (!exe) throw new Error('Ollama is not installed; cannot pull models.');
    const baseUrl = getOllamaBaseUrl();
    await waitForOllamaServer(exe, baseUrl, forward, signal);
    const { pulled, failed } = await pullMissingModels(options.models, baseUrl, forward, report, signal);
    if (failed.length > 0) throw new ReportedError(`Failed to pull: ${failed.join(', ')}`);
    return pulled.length > 0 ? 'pulled' : 'already present';
  });

  await runStep('Docker', options.installDocker ? null : 'skipped', () =>
    installDocker({ dockerEngineOnLinux: options.dockerEngineOnLinux, dryRun: options.dryRun, signal, emit: forward })
  );

  await runStep('Containers', await containersSkipReason(options, results.Docker, resources), () =>
    startContainers({
      composePath: resources!.composePath,
      credentialFiles: resources!.credentialFiles,
      dryRun: options.dryRun,
      signal,
      emit: forward,
    })
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
    failures: reports.map((r) => ({ step: r.step, summary: r.summary, hint: r.hint, hintId: r.hintId })),
  });
}

/** Why the Containers step can't run (shown as the skip detail), or null when it should run. */
async function containersSkipReason(
  options: InstallOptions,
  dockerResult: string | undefined,
  resources: InstallResources | undefined
): Promise<string | null> {
  if (!resources) return 'no container definition bundled';
  if (dockerResult === 'cancelled' || dockerResult?.startsWith('FAILED:')) return "Docker isn't ready";
  // A dry run doesn't install Docker, so only a real run can require it to be present.
  if (!options.dryRun && (await detectDocker()) === 'none') return "Docker isn't installed";
  return null;
}
