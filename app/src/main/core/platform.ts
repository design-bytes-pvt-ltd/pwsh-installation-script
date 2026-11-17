import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Arch, TargetOS } from './types';

export function getTargetOS(platform: NodeJS.Platform = process.platform): TargetOS {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  throw new Error(`Unsupported operating system: ${platform}`);
}

export async function execCommand(
  command: string,
  args: string[] = [],
  options: {
    signal?: AbortSignal;
    onOutput?: (line: string) => void;
    allowedExitCodes?: number[];
  } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const allowed = options.allowedExitCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (options.onOutput) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) options.onOutput(line);
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      if (options.onOutput) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) options.onOutput(line);
        }
      }
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      const exitCode = code ?? 1;
      if (!allowed.includes(exitCode)) {
        reject(new Error(`Command failed (exit code ${exitCode}): ${command} ${args.join(' ')}\n${stderr.trim()}`));
        return;
      }
      resolve({ exitCode, stdout, stderr });
    });
  });
}

export async function getArch(targetOS: TargetOS = getTargetOS()): Promise<Arch> {
  if (targetOS === 'macos') {
    try {
      const res = await execCommand('sysctl', ['-in', 'hw.optional.arm64']);
      if (res.stdout.trim() === '1') return 'arm64';
    } catch {
      // Fallback to process.arch below
    }
  }
  const arch = process.arch;
  if (arch === 'x64') return 'amd64';
  if (arch === 'arm64') return 'arm64';
  throw new Error(`Unsupported CPU architecture: ${arch}`);
}

export function parseOsRelease(content: string): Record<string, string> {
  const info: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) {
      info[match[1]] = match[2].replace(/^"|"$/g, '');
    }
  }
  return info;
}

export function getOsRelease(filePath = '/etc/os-release'): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  return parseOsRelease(fs.readFileSync(filePath, 'utf8'));
}

export async function commandExists(name: string, targetOS: TargetOS = getTargetOS()): Promise<string | null> {
  const locator = targetOS === 'windows' ? 'where' : 'which';
  try {
    const res = await execCommand(locator, [name]);
    const first = res.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

export function getTargetUser(env: NodeJS.ProcessEnv = process.env): string {
  return env.SUDO_USER || env.USERNAME || env.USER || '';
}

export function createTempDir(prefix = 'docker-ollama-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDirSafe(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

export async function execPrivileged(
  command: string,
  args: string[] = [],
  options: { signal?: AbortSignal; onOutput?: (line: string) => void } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const targetOS = getTargetOS();
  if (targetOS === 'windows') {
    return execCommand(command, args, options);
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return execCommand(command, args, options);
  }
  if (targetOS === 'macos') {
    const escaped = [command, ...args]
      .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
      .join(' ');
    const osaScript = `do shell script "${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`;
    return execCommand('osascript', ['-e', osaScript], options);
  }
  const pkexec = await commandExists('pkexec', targetOS);
  if (pkexec) {
    return execCommand(pkexec, [command, ...args], options);
  }
  return execCommand('sudo', ['-n', command, ...args], options);
}
