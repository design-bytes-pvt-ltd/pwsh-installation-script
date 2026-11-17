import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadFile } from './downloader';
import { getOllamaBaseUrl } from './models';
import {
  commandExists,
  createTempDir,
  execCommand,
  execPrivileged,
  getTargetOS,
  removeDirSafe,
} from './platform';
import { InstallEvent, TargetOS } from './types';

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

  const logMsg = (message: string) =>
    emit({ type: 'log', level: 'info', message, timestamp: new Date().toISOString() });

  logMsg('Waiting for Ollama server to start...');
  for (let i = 0; i < 15; i++) {
    if (signal?.aborted) throw new Error('Cancelled');
    await new Promise((r) => setTimeout(r, 1000));
    if (await isOllamaServerRunning(baseUrl)) return;
  }

  logMsg("Starting 'ollama serve' in the background...");
  const logFile = path.join(os.tmpdir(), 'ollama-serve.log');
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

export async function installOllama(options: {
  dryRun?: boolean;
  signal?: AbortSignal;
  emit: (event: InstallEvent) => void;
}): Promise<string> {
  const targetOS = getTargetOS();
  const existing = await getOllamaExe(targetOS);
  if (existing) {
    options.emit({ type: 'log', level: 'info', message: `Ollama already installed: ${existing}`, timestamp: new Date().toISOString() });
    return 'already present';
  }
  if (options.dryRun) {
    options.emit({ type: 'log', level: 'info', message: `[dry-run] Would install Ollama on ${targetOS}`, timestamp: new Date().toISOString() });
    return 'would install';
  }

  const onOutput = (line: string) =>
    options.emit({ type: 'log', level: 'info', message: line, timestamp: new Date().toISOString() });

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
      const tmp = createTempDir();
      try {
        const exe = path.join(tmp, 'OllamaSetup.exe');
        await downloadFile('https://ollama.com/download/OllamaSetup.exe', exe, {
          signal: options.signal,
          onProgress: (p) =>
            options.emit({ type: 'progress', step: 'Ollama', label: 'Downloading OllamaSetup.exe', completed: p.completed, total: p.total ?? undefined, percent: p.percent ?? undefined }),
        });
        await execCommand(exe, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES'], { signal: options.signal, onOutput });
      } finally {
        removeDirSafe(tmp);
      }
    }
  } else if (targetOS === 'macos') {
    const tmp = createTempDir();
    try {
      const zip = path.join(tmp, 'Ollama-darwin.zip');
      await downloadFile('https://ollama.com/download/Ollama-darwin.zip', zip, {
        signal: options.signal,
        onProgress: (p) =>
          options.emit({ type: 'progress', step: 'Ollama', label: 'Downloading Ollama-darwin.zip', completed: p.completed, total: p.total ?? undefined, percent: p.percent ?? undefined }),
      });
      try {
        await execCommand('ditto', ['-x', '-k', zip, '/Applications'], { signal: options.signal, onOutput });
      } catch {
        await execPrivileged('ditto', ['-x', '-k', zip, '/Applications'], { signal: options.signal, onOutput });
      }
      await execCommand('open', ['-a', '/Applications/Ollama.app'], { signal: options.signal, onOutput });
    } finally {
      removeDirSafe(tmp);
    }
  } else {
    const curl = await commandExists('curl', targetOS);
    if (!curl) throw new Error('curl is required to install Ollama on Linux.');
    await execCommand('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], { signal: options.signal, onOutput });
  }

  const exe = await getOllamaExe(targetOS);
  if (!exe) throw new Error('Ollama installation finished but the ollama binary was not found.');

  // Post-install health check
  await execCommand(exe, ['--version'], { signal: options.signal, onOutput });
  return 'installed';
}

export async function pullModelStream(
  modelName: string,
  baseUrl: string,
  onProgress: (progress: { status: string; completed?: number; total?: number; percent?: number }) => void,
  signal?: AbortSignal
): Promise<void> {
  const resp = await fetch(`${baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: modelName, stream: true }),
    signal,
  });

  if (!resp.ok || !resp.body) {
    throw new Error(`Failed to pull ${modelName}: HTTP ${resp.status} ${resp.statusText}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const chunk = JSON.parse(line) as { error?: string; status?: string; completed?: number; total?: number };
      if (chunk.error) throw new Error(chunk.error);
      const percent =
        chunk.total && chunk.total > 0 && typeof chunk.completed === 'number'
          ? Math.min(100, Math.round((chunk.completed / chunk.total) * 100))
          : undefined;
      onProgress({
        status: chunk.status ?? 'pulling',
        completed: chunk.completed,
        total: chunk.total,
        percent,
      });
    }
  }
}
