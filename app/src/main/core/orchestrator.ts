import fs from 'node:fs';
import { detectDocker, installDocker } from './docker';
import { getModelBudget } from './hardware';
import { buildModelRows, getInstalledModels, getOllamaBaseUrl, loadModelCatalog } from './models';
import { getOllamaExe, installOllama, pullModelStream, waitForOllamaServer } from './ollama';
import { getArch, getTargetOS } from './platform';
import { InstallEvent, InstallOptions, ProbeResult, StepName } from './types';

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

function formatForLog(event: InstallEvent): string | null {
  switch (event.type) {
    case 'log':
      return `[${event.level.toUpperCase()}] ${event.message}`;
    case 'step':
      return `[STEP] ${event.step}: ${event.status}${event.detail ? ` (${event.detail})` : ''}`;
    case 'note':
      return `[NOTE] ${event.message}`;
    case 'summary':
      return `[SUMMARY] ${JSON.stringify(event.results)} exitCode=${event.exitCode}${event.cancelled ? ' (cancelled)' : ''}`;
    default:
      return null; // progress events are too chatty for the log file
  }
}

/** Pulls each model, continuing past failures. Returns the names that failed. */
async function pullModels(
  models: string[],
  emit: (event: InstallEvent) => void,
  signal?: AbortSignal
): Promise<string[]> {
  const exe = await getOllamaExe();
  if (!exe) throw new Error('Ollama is not installed; cannot pull models.');
  const baseUrl = getOllamaBaseUrl();
  await waitForOllamaServer(exe, baseUrl, emit, signal);

  const failed: string[] = [];
  for (const model of models) {
    if (signal?.aborted) break;
    try {
      await pullModelStream(
        model,
        baseUrl,
        (p) => emit({ type: 'progress', step: 'Models', label: `${model}: ${p.status}`, completed: p.completed, total: p.total, percent: p.percent }),
        signal
      );
      emit({ type: 'log', level: 'info', message: `Pulled ${model}`, timestamp: new Date().toISOString() });
    } catch (err) {
      if (signal?.aborted) break;
      emit({ type: 'log', level: 'warn', message: `Failed to pull ${model}: ${(err as Error).message}`, timestamp: new Date().toISOString() });
      failed.push(model);
    }
  }
  return failed;
}

export async function runInstall(
  options: InstallOptions,
  emit: (event: InstallEvent) => void,
  signal?: AbortSignal,
  logPath?: string
): Promise<void> {
  const results: Record<string, string> = {};
  const notes: string[] = [];

  const forward = (event: InstallEvent) => {
    if (event.type === 'note') notes.push(event.message);
    const line = logPath ? formatForLog(event) : null;
    if (line) {
      try {
        fs.appendFileSync(logPath!, `[${new Date().toISOString()}] ${line}\n`);
      } catch {
        // Ignore log write failures
      }
    }
    emit(event);
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
      const msg = (err as Error).message;
      results[step] = `FAILED: ${msg}`;
      forward({ type: 'step', step, status: 'failed', detail: msg });
    }
  };

  await runStep('Ollama', options.installOllama ? null : 'skipped', () =>
    installOllama({ dryRun: options.dryRun, signal, emit: forward })
  );

  await runStep('Models', options.models.length === 0 ? 'skipped' : null, async () => {
    if (options.dryRun) {
      forward({ type: 'log', level: 'info', message: `[dry-run] Would pull: ${options.models.join(', ')}`, timestamp: new Date().toISOString() });
      return 'would pull';
    }
    const failed = await pullModels(options.models, forward, signal);
    if (failed.length > 0) throw new Error(`Failed to pull: ${failed.join(', ')}`);
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
    logPath,
  });
}
