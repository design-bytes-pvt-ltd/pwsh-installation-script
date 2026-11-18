import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandError, ElevationKind } from './errors';
import { Arch, TargetOS } from './types';

export function getTargetOS(platform: NodeJS.Platform = process.platform): TargetOS {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  throw new Error(`Unsupported operating system: ${platform}`);
}

export interface ExecOptions {
  signal?: AbortSignal;
  onOutput?: (line: string) => void;
  allowedExitCodes?: number[];
  env?: NodeJS.ProcessEnv;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Keep at most this many characters of captured stdout/stderr (the tail is kept). */
const MAX_CAPTURE_CHARS = 256 * 1024;

const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Turns a stream of text chunks into complete lines. Lines that span chunk boundaries are
 * joined, and progress output that redraws a line with \r (winget, curl, apt) only reports
 * its final state instead of every frame.
 */
export class LineSplitter {
  private buffer = '';

  constructor(private readonly emit: (line: string) => void) {}

  push(text: string): void {
    this.buffer += text;
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop() ?? '';
    for (const part of parts) this.emitLine(part);
    // A progress bar that never prints \n would otherwise grow the buffer without bound.
    const cr = this.buffer.lastIndexOf('\r');
    if (cr >= 0 && cr < this.buffer.length - 1) this.buffer = this.buffer.slice(cr + 1);
  }

  flush(): void {
    if (this.buffer) this.emitLine(this.buffer);
    this.buffer = '';
  }

  private emitLine(raw: string): void {
    // Spinners redraw with \r or ESC[<n>G (cursor to column); both start a new frame.
    const frames = raw
      .replace(/\x1b\[\d*G/g, '\r')
      .split('\r')
      .map((f) => f.replace(ANSI_PATTERN, '').replace(/\uFEFF/g, ''));
    const visible = [...frames].reverse().find((f) => f.trim() !== '') ?? '';
    // Spinners erase characters with backspace; apply them instead of just dropping them.
    let line = '';
    for (const ch of visible) line = ch === '\b' ? line.slice(0, -1) : line + ch;
    line = line.trimEnd();
    if (line.trim()) this.emit(line);
  }
}

/** Lines of output kept for failure reports. */
const TAIL_LINES = 40;

function pushTail(tail: string[], line: string): void {
  tail.push(line);
  if (tail.length > TAIL_LINES) tail.shift();
}

function appendCapped(acc: string, text: string): string {
  const next = acc + text;
  return next.length > MAX_CAPTURE_CHARS ? next.slice(next.length - MAX_CAPTURE_CHARS) : next;
}

export async function execCommand(command: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
  const allowed = options.allowedExitCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
      env: options.env ?? process.env,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const tail: string[] = [];
    const onLine = (l: string) => {
      pushTail(tail, l);
      options.onOutput?.(l);
    };
    const outLines = new LineSplitter(onLine);
    const errLines = new LineSplitter(onLine);

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout = appendCapped(stdout, text);
      outLines.push(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr = appendCapped(stderr, text);
      errLines.push(text);
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      outLines.flush();
      errLines.flush();
      const exitCode = code ?? 1;
      if (!allowed.includes(exitCode)) {
        reject(new CommandError({ command: [command, ...args].join(' '), exitCode, outputTail: tail }));
        return;
      }
      resolve({ exitCode, stdout, stderr });
    });
  });
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

/**
 * Polls a file for appended text and reports it line by line. Used for elevated processes
 * (UAC, osascript) whose output cannot be piped back to us directly.
 */
export function tailFile(filePath: string, onLine?: (line: string) => void, intervalMs = 300): () => void {
  let position = 0;
  const lines = new LineSplitter((l) => onLine?.(l));
  const readNew = () => {
    try {
      const size = fs.statSync(filePath).size;
      if (size <= position) return;
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(size - position);
        fs.readSync(fd, buf, 0, buf.length, position);
        position = size;
        lines.push(buf.toString('utf8'));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // File not written yet
    }
  };
  const timer = setInterval(readNew, intervalMs);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    readNew();
    lines.flush();
  };
}

function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function friendlyElevationError(err: unknown): Error {
  const output = err instanceof CommandError ? err.outputTail.join('\n') : '';
  const text = `${(err as Error)?.message ?? String(err)}\n${output}`;
  if (/User canceled|\(-128\)|cancell?ed by the user|Request dismissed|Not authorized|exit code 126|no password was provided|incorrect password attempts/i.test(text)) {
    return new Error('The administrator password prompt was cancelled or denied.');
  }
  return err as Error;
}

/**
 * Reads the marker lines that elevated scripts print, so a failure names the inner command
 * instead of "sh step.sh" or "powershell.exe":
 * - sh scripts run with `set -x` and PS4='@@CMD ', and an EXIT trap prints `@@ERROR-EXIT <code>`.
 * - The elevated PowerShell catch prints `@@ERROR`, `@@ERROR-CMD`, `@@ERROR-EXIT`, `@@ERROR-AT`, `@@ERROR-STACK`.
 * Traced commands are passed on as "$ <command>"; other markers are consumed.
 */
export class ScriptMarkers {
  lastCommand?: string;
  failedCommand?: string;
  exitCode?: number;
  message?: string;
  where?: string;
  readonly stack: string[] = [];
  readonly tail: string[] = [];

  constructor(private readonly forward?: (line: string) => void) {}

  push = (raw: string): void => {
    let line = raw;
    let m: RegExpExecArray | null;
    if ((m = /^@+CMD (.*)$/.exec(raw))) {
      this.lastCommand = m[1];
      // echo traces would repeat @@NOTE markers and add nothing to the log.
      if (/^echo\b/.test(m[1])) return;
      line = `$ ${m[1]}`;
    } else if ((m = /^@@ERROR-EXIT (-?\d+)/.exec(raw))) {
      this.exitCode = Number(m[1]);
      return;
    } else if ((m = /^@@ERROR-CMD (.*)$/.exec(raw))) {
      this.failedCommand = m[1];
      return;
    } else if ((m = /^@@ERROR-AT (.*)$/.exec(raw))) {
      this.where = m[1];
      return;
    } else if ((m = /^@@ERROR-STACK (.*)$/.exec(raw))) {
      this.stack.push(m[1]);
      return;
    } else if ((m = /^@@ERROR (.*)$/.exec(raw))) {
      this.message = m[1];
      return;
    }
    pushTail(this.tail, line);
    this.forward?.(line);
  };

  /** Rebuilds a failed run's error with what the markers revealed. */
  toError(err: unknown, elevated: ElevationKind): Error {
    const friendly = friendlyElevationError(err);
    if (friendly !== err || !(err instanceof CommandError)) return friendly;
    const command = this.failedCommand ?? (this.exitCode !== undefined ? this.lastCommand : undefined);
    const isCommandFailure = command !== undefined;
    return new CommandError({
      command,
      exitCode: isCommandFailure ? (this.exitCode ?? err.exitCode) : undefined,
      outputTail: this.tail.length > 0 ? this.tail : err.outputTail,
      elevated,
      where: this.where,
      details: this.stack.length > 0 ? ['PowerShell stack:', ...this.stack.map((s) => `  ${s}`)] : [],
      message: isCommandFailure ? undefined : (this.message ?? `The elevated script failed (exit code ${err.exitCode})`),
    });
  }
}

/** Preamble for root scripts: trace commands for failure reports and report the failing exit code. */
export const SH_PREAMBLE = [
  '#!/bin/sh',
  'set -e',
  'exec 2>&1',
  "PS4='@@CMD '",
  `trap '{ __rc=$?; set +x; } 2>/dev/null; if [ "$__rc" -ne 0 ]; then echo "@@ERROR-EXIT $__rc"; fi' EXIT`,
  'set -x',
].join('\n');

async function createLinuxAskpass(dir: string): Promise<string | null> {
  const prompt = 'Docker + Ollama Installer needs your password to install system packages.';
  let body: string | null = null;
  if (await commandExists('zenity', 'linux')) {
    body = `exec zenity --password --title=${quoteSh('Administrator password')} 2>/dev/null`;
  } else if (await commandExists('kdialog', 'linux')) {
    body = `exec kdialog --title ${quoteSh('Administrator password')} --password ${quoteSh(prompt)}`;
  } else if (await commandExists('ssh-askpass', 'linux')) {
    body = `exec ssh-askpass ${quoteSh(prompt)}`;
  }
  if (!body) return null;
  const file = path.join(dir, 'askpass.sh');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  return file;
}

/**
 * Runs a POSIX shell script as root on macOS/Linux with a single password prompt:
 * macOS uses the native administrator dialog (osascript), Linux uses pkexec or sudo with a
 * graphical askpass helper. The script runs with `set -e`.
 */
export async function execPrivilegedScript(script: string, options: ExecOptions = {}): Promise<ExecResult> {
  const targetOS = getTargetOS();
  if (targetOS === 'windows') throw new Error('execPrivilegedScript is for macOS/Linux; use execElevatedPowerShell on Windows.');

  const dir = createTempDir('docker-ollama-root-');
  const scriptPath = path.join(dir, 'step.sh');
  fs.writeFileSync(scriptPath, `${SH_PREAMBLE}\n${script.replace(/\r\n/g, '\n')}\n`, { mode: 0o700 });
  const markers = new ScriptMarkers(options.onOutput);
  const run = async (elevated: ElevationKind, command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<ExecResult> => {
    try {
      return await execCommand(command, args, { ...options, env: env ?? options.env, onOutput: markers.push });
    } catch (err) {
      throw markers.toError(err, elevated);
    }
  };
  try {
    if (isRoot()) return await run('root', '/bin/sh', [scriptPath]);

    if (targetOS === 'macos') {
      const logPath = path.join(dir, 'step.log');
      fs.writeFileSync(logPath, '');
      const shell = `/bin/sh ${quoteSh(scriptPath)} >> ${quoteSh(logPath)} 2>&1`;
      const stopTail = tailFile(logPath, markers.push);
      try {
        return await execCommand('osascript', ['-e', `do shell script ${quoteAppleScript(shell)} with administrator privileges`], {
          ...options,
          onOutput: undefined,
        });
      } catch (err) {
        stopTail();
        throw markers.toError(err, 'osascript');
      } finally {
        stopTail();
      }
    }

    const hasGui = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    const pkexec = hasGui ? await commandExists('pkexec', 'linux') : null;
    if (pkexec) return await run('pkexec', pkexec, ['/bin/sh', scriptPath]);
    const askpass = await createLinuxAskpass(dir);
    if (askpass) {
      return await run('sudo-askpass', 'sudo', ['-A', '/bin/sh', scriptPath], { ...(options.env ?? process.env), SUDO_ASKPASS: askpass });
    }
    throw new Error(
      'Administrator rights are needed, but no graphical password prompt is available. ' +
        'Install pkexec (polkit) or zenity, or run the installer as root.'
    );
  } finally {
    removeDirSafe(dir);
  }
}

/**
 * Runs a PowerShell script elevated (one UAC prompt) and streams its output back through a
 * log file. The body runs with $ErrorActionPreference = 'Continue' (Windows PowerShell 5.1 turns
 * redirected native stderr into errors, which 'Stop' would make fatal), so use
 * `Invoke-Checked <exe> @(args) [-Allowed 0,3010]` for native commands that must succeed and
 * `-ErrorAction Stop` on cmdlets. Lines starting with `@@NOTE ` can be used as markers.
 */
export async function execElevatedPowerShell(body: string, options: ExecOptions = {}): Promise<ExecResult> {
  const dir = createTempDir('docker-ollama-admin-');
  const scriptPath = path.join(dir, 'step.ps1');
  const logPath = path.join(dir, 'step.log');
  fs.writeFileSync(logPath, '');
  const script = [
    "$ErrorActionPreference = 'Continue'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$env:WSL_UTF8 = '1'",
    '[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12',
    `$log = ${quotePs(logPath)}`,
    '$script:FailedCmd = $null',
    '$script:FailedExit = $null',
    'function Invoke-Checked([string]$File, [string[]]$Arguments = @(), [int[]]$Allowed = @(0)) {',
    '  & $File @Arguments',
    '  if ($Allowed -notcontains $LASTEXITCODE) {',
    "    $script:FailedCmd = (@($File) + $Arguments) -join ' '",
    '    $script:FailedExit = $LASTEXITCODE',
    '    throw "Command failed (exit code $LASTEXITCODE): $script:FailedCmd"',
    '  }',
    '}',
    'try {',
    `  & {\n${body}\n} *>&1 | ForEach-Object { "$_" } | Out-File -FilePath $log -Append -Encoding utf8`,
    '  exit 0',
    '} catch {',
    '  $e = $_',
    '  $lines = @("@@ERROR $($e.Exception.Message -replace \'\\r?\\n\', \' \')")',
    // Only when this error came from Invoke-Checked (an earlier, handled failure may have set FailedCmd).
    '  if ($script:FailedCmd -and $e.Exception.Message -eq "Command failed (exit code $script:FailedExit): $script:FailedCmd") {',
    '    $lines += "@@ERROR-CMD $script:FailedCmd"; $lines += "@@ERROR-EXIT $script:FailedExit"',
    '  }',
    '  if ($e.InvocationInfo -and $e.InvocationInfo.ScriptLineNumber) {',
    '    $lines += "@@ERROR-AT elevated script line $($e.InvocationInfo.ScriptLineNumber): $($e.InvocationInfo.Line.Trim())"',
    '  }',
    '  foreach ($f in ("$($e.ScriptStackTrace)" -split "`r?`n")) { if ($f.Trim()) { $lines += "@@ERROR-STACK $($f.Trim())" } }',
    '  $lines | Out-File -FilePath $log -Append -Encoding utf8',
    '  exit 1',
    '}',
  ].join('\r\n');
  fs.writeFileSync(scriptPath, script, 'utf8');

  const launcher =
    `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru ` +
    `-ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ${quotePs(`"${scriptPath}"`)}); exit $p.ExitCode`;
  const markers = new ScriptMarkers(options.onOutput);
  const stopTail = tailFile(logPath, markers.push);
  try {
    return await execCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launcher], {
      ...options,
      onOutput: undefined,
    });
  } catch (err) {
    stopTail(); // read the last lines (the error markers) before building the error
    throw markers.toError(err, 'uac');
  } finally {
    stopTail();
    removeDirSafe(dir);
  }
}

/** Runs one command with administrator/root rights (one password or UAC prompt). */
export async function execPrivileged(command: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
  if (getTargetOS() === 'windows') {
    return execElevatedPowerShell(`Invoke-Checked ${quotePs(command)} @(${args.map(quotePs).join(', ')})`, options);
  }
  return execPrivilegedScript(`exec ${[command, ...args].map(quoteSh).join(' ')}`, options);
}
