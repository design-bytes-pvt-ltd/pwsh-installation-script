import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Arch, TargetOS } from '../../shared/types';
import { execCommand } from './exec';

export function getTargetOS(platform: NodeJS.Platform = process.platform): TargetOS {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  throw new Error(`Unsupported operating system: ${platform}`);
}

/** Detects ARM64 Windows even when an x64 build of the app runs under emulation. */
export function isWindowsArm64(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PROCESSOR_ARCHITEW6432 === 'ARM64' || env.PROCESSOR_ARCHITECTURE === 'ARM64') return true;
  return /^ARM/i.test(env.PROCESSOR_IDENTIFIER ?? '');
}

export async function getArch(targetOS: TargetOS = getTargetOS()): Promise<Arch> {
  if (targetOS === 'macos') {
    try {
      // Correct even when the app runs under Rosetta.
      const res = await execCommand('sysctl', ['-in', 'hw.optional.arm64']);
      if (res.stdout.trim() === '1') return 'arm64';
    } catch {
      // Fall back to process.arch below
    }
  }
  if (targetOS === 'windows' && isWindowsArm64()) return 'arm64';
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

/**
 * The account that should own the installed tools (docker group, Docker Desktop --user).
 * On Windows this is DOMAIN\user so domain accounts can be added to local groups.
 */
export function getTargetUser(env: NodeJS.ProcessEnv = process.env, targetOS: TargetOS = getTargetOS()): string {
  if (targetOS === 'windows') {
    const user = env.USERNAME ?? '';
    return user && env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
  }
  return env.SUDO_USER || env.USER || env.LOGNAME || '';
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

/** Quotes one argument for POSIX sh. */
export function quoteSh(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Quotes one argument as a PowerShell single-quoted string. */
export function quotePs(arg: string): string {
  return `'${arg.replace(/'/g, "''")}'`;
}

/** Escapes text for use inside an AppleScript double-quoted string. */
export function quoteAppleScript(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
