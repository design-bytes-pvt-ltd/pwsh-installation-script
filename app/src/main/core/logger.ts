import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ErrorReport,
  formatFailureReport,
  formatHeader,
  formatRunEnd,
  formatTimelineLine,
  RULE,
  toErrorReport,
} from './errors';
import { getOsRelease, getTargetOS, isWindowsArm64 } from './platform';
import type { InstallEvent, InstallOptions } from '../../shared/types';

/** Log folder name; matches the packaged app's productName. */
export const LOG_DIR_NAME = 'Enterprise Brain Installer';
export const LOGS_TO_KEEP = 10;

/**
 * Same folder as Electron's app.getPath('logs') for the packaged app, computed here so it is the
 * same in dev builds (where the app name differs) and testable without Electron.
 */
export function defaultLogDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (platform === 'win32') {
    return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), LOG_DIR_NAME, 'logs');
  }
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Logs', LOG_DIR_NAME);
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), LOG_DIR_NAME, 'logs');
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** 14:02:11.120 */
export function formatClock(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** 2026-11-18 14:02:11 +05:30 */
export function formatStarted(d: Date): string {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** 20261118-140211, used in log file names. */
export function fileStamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Deletes all but the newest `keep` install/crash logs. Never throws. */
export function pruneOldLogs(dir: string, keep = LOGS_TO_KEEP): void {
  try {
    const logs = fs
      .readdirSync(dir)
      .filter((f) => /^(install|crash)-.*\.log$/.test(f))
      .map((f) => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of logs.slice(keep)) fs.rmSync(old.file, { force: true });
  } catch {
    // Pruning is best-effort
  }
}

function isAdmin(): boolean {
  if (process.platform === 'win32') {
    try {
      execFileSync('net', ['session'], { stdio: 'ignore', timeout: 3000, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** "macOS 15.1 (arm64)   user: alice   admin: no" */
export function describeSystem(): string {
  let name: string;
  try {
    const targetOS = getTargetOS();
    if (targetOS === 'macos') {
      name = `macOS ${execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 3000 }).trim()}`;
    } else if (targetOS === 'linux') {
      name = getOsRelease().PRETTY_NAME || `Linux ${os.release()}`;
    } else {
      name = `${os.version()} (${os.release()})`;
    }
  } catch {
    name = `${os.type()} ${os.release()}`;
  }
  const arch = isWindowsArm64() || os.arch() === 'arm64' ? 'arm64' : os.arch() === 'x64' ? 'amd64' : os.arch();
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    user = process.env.USER || process.env.USERNAME || 'unknown';
  }
  return `${name} (${arch})   user: ${user}   admin: ${isAdmin() ? 'yes' : 'no'}`;
}

const yn = (b: boolean | undefined) => (b ? 'yes' : 'no');

/** "ollama=yes  models=qwen3:8b  docker=yes  engine=no  dry-run=no" */
export function describeOptions(o: InstallOptions): string {
  return `ollama=${yn(o.installOllama)}  models=${o.models.join(',') || 'none'}  docker=${yn(o.installDocker)}  engine=${yn(o.dockerEngineOnLinux)}  dry-run=${yn(o.dryRun)}`;
}

export type LogLevel = 'STEP' | 'INFO' | 'WARN' | 'ERROR' | 'OUT' | 'NOTE';

export interface LogHeader {
  source: string;
  system: string;
  options: string;
  started?: Date;
}

/**
 * Writes the shared, human-readable install log: a header, a timeline, then a summary and one
 * FAILURE REPORT per error. Every write is synchronous (a crash still leaves the log on disk)
 * and no method ever throws: a broken log must not break the install.
 */
export class InstallLogger {
  private readonly reports: ErrorReport[] = [];
  private readonly startedAt: number;
  private step = '';
  private warned = false;

  constructor(readonly filePath: string, header: LogHeader) {
    const started = header.started ?? new Date();
    this.startedAt = started.getTime();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch {
      // write() reports the problem
    }
    this.write(
      formatHeader({ started: formatStarted(started), source: header.source, system: header.system, options: header.options, logFile: filePath })
    );
  }

  get failures(): readonly ErrorReport[] {
    return this.reports;
  }

  line(level: LogLevel, message: string, step: string = this.step): void {
    this.guard(() => this.write(formatTimelineLine(formatClock(new Date()), level, step, message)));
  }

  /** Records one install event. Progress events are too chatty for the file and are skipped. */
  event(evt: InstallEvent): void {
    this.guard(() => {
      switch (evt.type) {
        case 'step':
          if (evt.status === 'running') this.step = evt.step;
          this.line('STEP', evt.detail ? `${evt.status}: ${evt.detail}` : evt.status, evt.step);
          break;
        case 'log':
          this.line(evt.output ? 'OUT' : (evt.level.toUpperCase() as LogLevel), evt.message);
          break;
        case 'note':
          this.line('NOTE', evt.message);
          break;
        case 'summary':
          this.write(
            formatRunEnd(
              { results: evt.results, notes: evt.notes, exitCode: evt.exitCode, durationMs: Date.now() - this.startedAt, cancelled: evt.cancelled },
              this.reports
            )
          );
          break;
        default:
          break;
      }
    });
  }

  /** Stores a failure (written in full at the end of the run) and logs a one-line ERROR now. */
  failure(report: ErrorReport): void {
    this.reports.push(report);
    this.line('ERROR', report.hint ? `${report.summary}\nHint: ${report.hint}` : report.summary, report.step.split(':')[0]);
  }

  /** Writes a crash (uncaught exception, renderer gone...) immediately and in full. */
  crash(kind: string, err: unknown): ErrorReport {
    const report = toErrorReport(err, kind);
    this.guard(() => {
      this.line('ERROR', `${kind}: ${report.summary}`, 'crash');
      this.write(`${formatFailureReport(report, 1, 1)}\n${RULE}`);
    });
    return report;
  }

  /** All failure reports of this run as text (for "Copy error report"). */
  reportText(): string {
    if (this.reports.length === 0) return '';
    return [...this.reports.map((r, i) => formatFailureReport(r, i + 1, this.reports.length)), RULE].join('\n');
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.warnOnce(err);
    }
  }

  private write(text: string): void {
    try {
      fs.appendFileSync(this.filePath, `${text}\n`, 'utf8');
    } catch (err) {
      this.warnOnce(err);
    }
  }

  private warnOnce(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.error(`[logger] could not write ${this.filePath}: ${(err as Error)?.message ?? String(err)}`);
  }
}
