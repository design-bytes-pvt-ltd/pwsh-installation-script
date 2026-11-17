import fs from 'node:fs';
import { detectDocker, installDocker } from './docker';
import { getModelBudget } from './hardware';
import { buildModelRows, getInstalledModels, getOllamaBaseUrl, loadModelCatalog } from './models';
import { getOllamaExe, installOllama, pullModelStream, waitForOllamaServer } from './ollama';
import { getArch, getTargetOS } from './platform';
import { InstallEvent, InstallOptions, ProbeResult } from './types';

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

export async function runInstall(
  options: InstallOptions,
  emit: (event: InstallEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const results: Record<string, string> = {};
  const notes: string[] = [];

  const forward = (event: InstallEvent) => {
    if (event.type === 'note') notes.push(event.message);
    if (options.logPath && event.type === 'log') {
      try {
        fs.appendFileSync(options.logPath, `[${event.timestamp}] [${event.level.toUpperCase()}] ${event.message}\n`);
      } catch {
        // Ignore log write failures
      }
    }
    emit(event);
  };

  // Step 1: Ollama
  if (!options.installOllama) {
    results.Ollama = 'skipped';
    forward({ type: 'step', step: 'Ollama', status: 'skipped' });
  } else {
    forward({ type: 'step', step: 'Ollama', status: 'running' });
    try {
      const status = await installOllama({ dryRun: options.dryRun, signal, emit: forward });
      results.Ollama = status;
      forward({ type: 'step', step: 'Ollama', status: 'done', detail: status });
    } catch (err) {
      const msg = (err as Error).message;
      results.Ollama = `FAILED: ${msg}`;
      forward({ type: 'step', step: 'Ollama', status: 'failed', detail: msg });
    }
  }

  // Step 2: Models
  if (options.models.length === 0) {
    results.Models = 'skipped';
    forward({ type: 'step', step: 'Models', status: 'skipped' });
  } else if (options.dryRun) {
    results.Models = 'would pull';
    forward({ type: 'step', step: 'Models', status: 'done', detail: `would pull: ${options.models.join(', ')}` });
  } else {
    forward({ type: 'step', step: 'Models', status: 'running' });
    try {
      const exe = await getOllamaExe();
      if (!exe) throw new Error('Ollama is not installed; cannot pull models.');
      const baseUrl = getOllamaBaseUrl();
      await waitForOllamaServer(exe, baseUrl, forward, signal);

      for (const model of options.models) {
        await pullModelStream(
          model,
          baseUrl,
          (p) =>
            forward({
              type: 'progress',
              step: 'Models',
              label: `${model}: ${p.status}`,
              completed: p.completed,
              total: p.total,
              percent: p.percent,
            }),
          signal
        );
      }
      results.Models = 'pulled';
      forward({ type: 'step', step: 'Models', status: 'done', detail: 'pulled' });
    } catch (err) {
      const msg = (err as Error).message;
      results.Models = `FAILED: ${msg}`;
      forward({ type: 'step', step: 'Models', status: 'failed', detail: msg });
    }
  }

  // Step 3: Docker
  if (!options.installDocker) {
    results.Docker = 'skipped';
    forward({ type: 'step', step: 'Docker', status: 'skipped' });
  } else {
    forward({ type: 'step', step: 'Docker', status: 'running' });
    try {
      const status = await installDocker({
        dockerEngineOnLinux: options.dockerEngineOnLinux,
        dryRun: options.dryRun,
        signal,
        emit: forward,
      });
      results.Docker = status;
      forward({ type: 'step', step: 'Docker', status: 'done', detail: status });
    } catch (err) {
      const msg = (err as Error).message;
      results.Docker = `FAILED: ${msg}`;
      forward({ type: 'step', step: 'Docker', status: 'failed', detail: msg });
    }
  }

  const uniqueNotes = Array.from(new Set(notes));
  const hasFailures = Object.values(results).some((v) => v.startsWith('FAILED:'));
  forward({ type: 'summary', results, notes: uniqueNotes, exitCode: hasFailures ? 1 : 0 });
}
