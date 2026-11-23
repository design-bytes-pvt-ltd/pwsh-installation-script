import fs from 'node:fs';
import path from 'node:path';
import { CommandError, ElevationKind } from './errors';
import { execCommand, ExecOptions, ExecResult, pushTail, tailFile } from './exec';
import { commandExists, createTempDir, getTargetOS, quoteAppleScript, quotePs, quoteSh, removeDirSafe } from './platform';

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
  const prompt = 'Enterprise Brain Installer needs your password to install system packages.';
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
