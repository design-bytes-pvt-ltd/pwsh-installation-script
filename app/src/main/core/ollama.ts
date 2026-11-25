import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { discardDownload, downloadCachePath, downloadFile } from './downloader';
import { getOllamaBaseUrl } from './models';
import { execPrivileged, execPrivilegedScript } from './elevation';
import { downloadReporting, logEvent, networkReporter } from './events';
import { execCommand } from './exec';
import { commandExists, createTempDir, getTargetOS, quotePs, quoteSh, removeDirSafe } from './platform';
import type { InstallEvent, TargetOS } from '../../shared/types';

export async function getOllamaExe(targetOS: TargetOS = getTargetOS()): Promise<string | null> {
  const fromPath = await commandExists('ollama', targetOS);
  if (fromPath) return fromPath;

  const candidates: string[] = [];
  if (targetOS === 'windows') {
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'));
    }
    if (process.env.USERPROFILE) {
      candidates.push(path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'));
    }
  } else if (targetOS === 'macos') {
    candidates.push('/Applications/Ollama.app/Contents/Resources/ollama');
  } else {
    candidates.push('/usr/local/bin/ollama', '/usr/bin/ollama');
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export async function isOllamaServerRunning(baseUrl: string = getOllamaBaseUrl()): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function waitForOllamaServer(
  ollamaExe: string,
  baseUrl: string,
  emit: (event: InstallEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  if (await isOllamaServerRunning(baseUrl)) return;

  const logMsg = (message: string) => emit(logEvent(message));

  logMsg('Waiting for Ollama server to start...');
  for (let i = 0; i < 15; i++) {
    if (signal?.aborted) throw new Error('Cancelled');
    await new Promise((r) => setTimeout(r, 1000));
    if (await isOllamaServerRunning(baseUrl)) return;
  }

  logMsg("Starting 'ollama serve' in the background...");
  // Per-run directory: a fixed name in a shared /tmp could be pre-created as a symlink.
  const logFile = path.join(createTempDir('ollama-serve-'), 'ollama-serve.log');
  const out = fs.openSync(logFile, 'a');
  const err = fs.openSync(`${logFile}.err`, 'a');
  const child = spawn(ollamaExe, ['serve'], {
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
  });
  child.unref();

  for (let i = 0; i < 45; i++) {
    if (signal?.aborted) throw new Error('Cancelled');
    await new Promise((r) => setTimeout(r, 1000));
    if (await isOllamaServerRunning(baseUrl)) return;
  }
  throw new Error(`Ollama server did not become reachable on ${baseUrl} (see ${logFile}.err).`);
}

/** Throws unless the file carries a valid Authenticode signature (Windows). */
async function verifyAuthenticode(file: string, exec: { signal?: AbortSignal; onOutput?: (line: string) => void }): Promise<void> {
  const ps =
    `$s = Get-AuthenticodeSignature -FilePath ${quotePs(file)}; ` +
    `"Signature: $($s.Status) $($s.SignerCertificate.Subject)"; if ($s.Status -ne 'Valid') { exit 1 }`;
  try {
    await execCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], exec);
  } catch {
    throw new Error(`Refusing to run ${path.basename(file)}: its digital signature is missing or invalid.`);
  }
}

/** A finished installer download younger than this is reused on Retry instead of fetched again. */
const REUSE_DOWNLOAD_MS = 24 * 60 * 60 * 1000;

export async function installOllama(options: {
  dryRun?: boolean;
  signal?: AbortSignal;
  emit: (event: InstallEvent) => void;
}): Promise<string> {
  const targetOS = getTargetOS();
  const existing = await getOllamaExe(targetOS);
  if (existing) {
    options.emit(logEvent(`Ollama already installed: ${existing}`));
    return 'already present';
  }
  if (options.dryRun) {
    options.emit(logEvent(`[dry-run] Would install Ollama on ${targetOS}`));
    return 'would install';
  }

  const onOutput = (line: string) => options.emit(logEvent(line, 'info', true));

  if (targetOS === 'windows') {
    const winget = await commandExists('winget', targetOS);
    let installedViaWinget = false;
    if (winget) {
      try {
        await execCommand(
          winget,
          ['install', '-e', '--id', 'Ollama.Ollama', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'],
          { signal: options.signal, onOutput }
        );
        installedViaWinget = true;
      } catch {
        // Fallback to direct installer
      }
    }
    if (!installedViaWinget || !(await getOllamaExe(targetOS))) {
      // Kept between runs, so a dropped or cancelled download resumes on Retry.
      const url = 'https://ollama.com/download/OllamaSetup.exe';
      const exe = downloadCachePath(url, 'OllamaSetup.exe');
      await downloadFile(url, exe, {
        signal: options.signal,
        reuseForMs: REUSE_DOWNLOAD_MS,
        ...downloadReporting(options.emit, 'Ollama', 'OllamaSetup.exe'),
      });
      await verifyAuthenticode(exe, { signal: options.signal, onOutput });
      await execCommand(exe, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES'], { signal: options.signal, onOutput });
      discardDownload(exe);
    }
  } else if (targetOS === 'macos') {
    const url = 'https://ollama.com/download/Ollama-darwin.zip';
    const zip = downloadCachePath(url, 'Ollama-darwin.zip');
    await downloadFile(url, zip, {
      signal: options.signal,
      reuseForMs: REUSE_DOWNLOAD_MS,
      ...downloadReporting(options.emit, 'Ollama', 'Ollama-darwin.zip'),
    });
    const tmp = createTempDir();
    try {
      // Extract and verify the signature before anything lands in /Applications.
      const extracted = path.join(tmp, 'extracted');
      await execCommand('ditto', ['-x', '-k', zip, extracted], { signal: options.signal, onOutput });
      const app = path.join(extracted, 'Ollama.app');
      await execCommand('codesign', ['--verify', '--deep', app], { signal: options.signal, onOutput });
      try {
        await execCommand('ditto', [app, '/Applications/Ollama.app'], { signal: options.signal, onOutput });
      } catch {
        await execPrivileged('ditto', [app, '/Applications/Ollama.app'], { signal: options.signal, onOutput });
      }
      await execCommand('open', ['-a', '/Applications/Ollama.app'], { signal: options.signal, onOutput });
      discardDownload(zip);
    } finally {
      removeDirSafe(tmp);
    }
  } else {
    // install.sh calls sudo itself, which cannot prompt without a terminal. Run it as root
    // instead (one graphical password prompt); as root it needs no sudo.
    const tmp = createTempDir();
    try {
      const scriptPath = path.join(tmp, 'ollama-install.sh');
      await downloadFile('https://ollama.com/install.sh', scriptPath, {
        signal: options.signal,
        onNetwork: networkReporter(options.emit, 'Ollama', 'downloading the Ollama install script'),
      });
      await execPrivilegedScript(`sh ${quoteSh(scriptPath)}`, { signal: options.signal, onOutput });
    } finally {
      removeDirSafe(tmp);
    }
  }

  const exe = await getOllamaExe(targetOS);
  if (!exe) throw new Error('Ollama installation finished but the ollama binary was not found.');

  // Post-install health check
  await execCommand(exe, ['--version'], { signal: options.signal, onOutput });
  return 'installed';
}

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
  percent?: number;
}

/** Parses one line of /api/pull NDJSON. Throws on an error chunk. */
export function parsePullLine(line: string): PullProgress {
  const chunk = JSON.parse(line) as { error?: string; status?: string; completed?: number; total?: number };
  if (chunk.error) throw new Error(chunk.error);
  const percent =
    chunk.total && chunk.total > 0 && typeof chunk.completed === 'number'
      ? Math.min(100, Math.round((chunk.completed / chunk.total) * 100))
      : undefined;
  return { status: chunk.status ?? 'pulling', completed: chunk.completed, total: chunk.total, percent };
}

/** No progress while pulling for too long. Ollama keeps what it has, so a retry resumes. */
export class ModelPullStalledError extends Error {
  readonly networkRetryable = true;
  constructor(model: string, idleMs: number) {
    super(`No progress while pulling ${model} for ${Math.round(idleMs / 60_000)} minutes.`);
    this.name = 'ModelPullStalledError';
  }
}

export interface PullWatchdogLimits {
  /** Bytes not moving while a layer downloads. */
  downloadMs: number;
  /** Other phases (manifest, verifying the digest of a big model, writing it): little to report. */
  otherMs: number;
}

/**
 * Streams /api/pull. A watchdog aborts the pull when neither the status nor the byte count changes
 * for too long, so a hung connection fails (and can be retried) instead of hanging the step.
 */
export async function pullModelStream(
  modelName: string,
  baseUrl: string,
  onProgress: (progress: PullProgress) => void,
  signal?: AbortSignal,
  limits: PullWatchdogLimits = { downloadMs: 180_000, otherMs: 600_000 }
): Promise<void> {
  const stop = new AbortController();
  const combined = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  let lastKey = '';
  let lastChange = Date.now();
  let downloading = false;
  let stalledAfter = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const watchdog = setInterval(() => {
    const limit = downloading ? limits.downloadMs : limits.otherMs;
    if (!stalledAfter && Date.now() - lastChange >= limit) {
      stalledAfter = Date.now() - lastChange;
      stop.abort();
      // Also end the read directly, in case the body ignores the abort.
      reader?.cancel().catch(() => {});
    }
  }, 1_000);
  const rethrow = (err: unknown): never => {
    if (stalledAfter && !signal?.aborted) throw new ModelPullStalledError(modelName, stalledAfter);
    throw err;
  };

  try {
    const resp = await fetch(`${baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, stream: true }),
      signal: combined,
    }).catch(rethrow);

    if (!resp.ok || !resp.body) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`Failed to pull ${modelName}: HTTP ${resp.status} ${resp.statusText} ${detail}`.trim());
    }

    reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastStatus = '';

    const handle = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line) return;
      const progress = parsePullLine(line);
      lastStatus = progress.status;
      const key = `${progress.status}|${progress.completed ?? ''}`;
      if (key !== lastKey) {
        lastKey = key;
        lastChange = Date.now();
      }
      downloading = typeof progress.total === 'number' && progress.total > 0 && (progress.completed ?? 0) < progress.total;
      onProgress(progress);
    };

    while (true) {
      const { done, value } = await reader.read().catch(rethrow);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach(handle);
    }
    if (stalledAfter && !signal?.aborted) throw new ModelPullStalledError(modelName, stalledAfter);
    handle(buffer + decoder.decode());

    // The stream ends with {"status":"success"}; anything else means it was cut off.
    if (lastStatus !== 'success') {
      throw new Error(`Pull of ${modelName} ended unexpectedly (last status: ${lastStatus || 'none'}).`);
    }
  } finally {
    clearInterval(watchdog);
  }
}
