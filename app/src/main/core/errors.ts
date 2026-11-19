/**
 * Turns anything thrown during an install into a readable failure report.
 *
 * The expected report text, hints and masking are pinned by __tests__/fixtures/error-report.json;
 * update it (see error-report.fixture.test.ts) when you change the format on purpose.
 */

export type ElevationKind = 'uac' | 'osascript' | 'pkexec' | 'sudo-askpass' | 'root';

export const ELEVATION_LABELS: Record<string, string> = {
  uac: 'yes (Windows UAC prompt)',
  osascript: 'yes (macOS administrator prompt)',
  pkexec: 'yes (pkexec)',
  'sudo-askpass': 'yes (sudo with a password dialog)',
  root: 'yes (already running as root)',
};

/** A failed external command, with the context needed to explain it. */
export class CommandError extends Error {
  readonly command?: string;
  readonly exitCode?: number;
  readonly summary: string;
  readonly outputTail: string[];
  readonly elevated?: ElevationKind;
  readonly where?: string;
  readonly details: string[];

  constructor(init: {
    command?: string;
    exitCode?: number;
    outputTail?: string[];
    elevated?: ElevationKind;
    where?: string;
    details?: string[];
    /** Overrides the default "Command failed (exit code N)" summary. */
    message?: string;
  }) {
    const summary = init.message ?? `Command failed (exit code ${init.exitCode ?? 'unknown'})`;
    super(init.message ?? (init.command ? `${summary}: ${init.command}` : summary));
    this.name = 'CommandError';
    this.command = init.command;
    this.exitCode = init.exitCode;
    this.summary = summary;
    this.outputTail = init.outputTail ?? [];
    this.elevated = init.elevated;
    this.where = init.where;
    this.details = init.details ?? [];
  }
}

/** Marks an error whose details were already reported (so a step does not report it twice). */
export class ReportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportedError';
  }
}

export interface ErrorReport {
  step: string;
  summary: string;
  command?: string;
  exitCode?: number;
  elevated?: string;
  where?: string;
  hintId?: string;
  hint?: string;
  /** The last REPORT_OUTPUT_LINES lines of output. */
  output: string[];
  /** How many output lines there were before truncation. */
  outputTotal: number;
  details: string[];
}

export interface ReportInput {
  step: string;
  message: string;
  command?: string;
  exitCode?: number;
  elevated?: string;
  where?: string;
  output?: string[];
  details?: string[];
}

export const REPORT_OUTPUT_LINES = 20;
export const RULE = '='.repeat(80);
export const THIN_RULE = '-'.repeat(80);

export interface Hint {
  id: string;
  exitCodes?: number[];
  /** Case-insensitive regular expression. */
  pattern?: string;
  text: string;
}

/** First match wins, so specific causes come before broad ones. */
export const HINTS: Hint[] = [
  {
    id: 'elevation-cancelled',
    pattern: 'password prompt was cancelled|User canceled|\\(-128\\)|Request dismissed|Not authorized|cancell?ed by the user|no password was provided|a password is required|incorrect password attempts',
    text: 'The administrator password prompt was cancelled or denied. Run the installer again and approve the prompt.',
  },
  {
    id: 'ollama-unreachable',
    pattern: 'Ollama server did not become reachable|Ollama is not running|(127\\.0\\.0\\.1|localhost):11434',
    text: "The Ollama server is not running. Start the Ollama app (or run 'ollama serve') and try again.",
  },
  {
    id: 'model-not-found',
    pattern: 'pull model manifest|file does not exist|manifest unknown',
    text: 'Ollama could not find this model. Check the exact name and tag at https://ollama.com/library.',
  },
  {
    id: 'signature-invalid',
    pattern: 'signature check failed|signature is missing or invalid|code object is not signed|a sealed resource is missing|invalid signature',
    text: 'The downloaded installer failed its signature check, so it was not run. Retry on a trusted network, or download it from the vendor site.',
  },
  {
    id: 'wsl-reboot',
    exitCodes: [3010],
    pattern: 'reboot is required|restart is required|restart your computer',
    text: 'Windows needs a restart to finish this install (WSL2). Reboot, then run the installer again.',
  },
  {
    id: 'dpkg-lock',
    pattern: 'Could not get lock|dpkg frontend lock|Unable to acquire the dpkg',
    text: 'Another package manager (apt or Software Updater) is running. Wait for it to finish, then retry.',
  },
  {
    id: 'disk-full',
    pattern: 'ENOSPC|No space left on device|not enough (disk )?space|disk is full',
    text: 'The disk is full. Free some space (each model needs several GB) and retry.',
  },
  {
    id: 'winget-missing',
    pattern: 'winget(\\.exe)?.{0,40}(is not recognized|not found|ENOENT)',
    text: "winget (App Installer) is missing or broken. Install 'App Installer' from the Microsoft Store and retry.",
  },
  {
    id: 'needs-admin',
    exitCodes: [740],
    pattern: 'requires elevation|0x80070005|Access is denied|Permission denied|EACCES|EPERM|must be run as root|are you root',
    text: 'This step needs administrator rights. Approve the administrator prompt, or run the installer from an administrator account.',
  },
  {
    id: 'network',
    pattern: 'ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|getaddrinfo|Could not resolve host|Network is unreachable|Failed to download|timed out|unable to connect|certificate verify failed|unable to get local issuer certificate',
    text: 'A network request failed. Check your internet connection, proxy or firewall, then retry.',
  },
  {
    id: 'command-not-found',
    exitCodes: [127],
    pattern: 'ENOENT|command not found|is not recognized as|not found in PATH|No such file or directory',
    text: 'A required program or file was not found. Make sure it is installed and on PATH, then retry.',
  },
];

export function findHint(text: string, exitCode?: number): Hint | undefined {
  return HINTS.find(
    (h) => (exitCode !== undefined && h.exitCodes?.includes(exitCode)) || (h.pattern && new RegExp(h.pattern, 'i').test(text))
  );
}

const REDACTIONS: Array<[RegExp, string]> = [
  [/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***:***@'],
  [/((?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*)[^\s&"']+/gi, '$1***'],
  [/(Authorization:\s*(?:Bearer\s+|Basic\s+)?)[^\s"']+/gi, '$1***'],
];

/** Masks credentials that commands sometimes echo (URLs with user:pass, token=..., auth headers). */
export function redact(text: string): string {
  return REDACTIONS.reduce((acc, [re, rep]) => acc.replace(re, rep), text);
}

function cleanLines(lines: string[]): string[] {
  return lines.map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '');
}

/** Builds a report from plain fields: splits the summary off, truncates output and picks a hint. */
export function createErrorReport(input: ReportInput): ErrorReport {
  const messageLines = cleanLines(String(input.message ?? '').split(/\r?\n/));
  const summary = messageLines[0]?.trim() || 'Unknown error';
  const details = [...messageLines.slice(1), ...cleanLines(input.details ?? [])];
  const allOutput = cleanLines(input.output ?? []);
  const command = input.command?.replace(/\s+/g, ' ').trim() || undefined;
  const hint = findHint([summary, command ?? '', ...details, ...allOutput].join('\n'), input.exitCode);
  return {
    step: input.step,
    summary,
    command,
    exitCode: input.exitCode,
    elevated: input.elevated || undefined,
    where: input.where?.trim() || undefined,
    hintId: hint?.id,
    hint: hint?.text,
    output: allOutput.slice(-REPORT_OUTPUT_LINES),
    outputTotal: allOutput.length,
    details,
  };
}

function describeError(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code;
    return `${e.name}${code ? ` [${code}]` : ''}: ${e.message}`;
  }
  return typeof e === 'string' ? e : safeJson(e);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const FRAME_PATH = /\((?:file:\/\/)?[^()]*[\\/]([^\\/()]+:\d+:\d+)\)/;

/** Stack frames with paths shortened to the file name. */
export function stackFrames(stack: string | undefined, max = 15): string[] {
  if (!stack) return [];
  return stack
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('at '))
    .slice(0, max)
    .map((l) => l.replace(FRAME_PATH, '($1)').replace(/^at (async )?(?:file:\/\/\/?)?.*[\\/]([^\\/\s()]+:\d+:\d+)$/, 'at $1$2'));
}

/** "docker.js line 142 (installDocker)" for the first frame in our own code. */
export function whereFromStack(stack: string | undefined): string | undefined {
  for (const frame of stackFrames(stack, 30)) {
    if (/node:|node_modules|errors\.[jt]s/.test(frame)) continue;
    const m = /^at (?:(?:async )?(.+?) \()?(?:.*[\\/])?([^\\/():]+):(\d+):\d+\)?$/.exec(frame);
    if (m) return `${m[2]} line ${m[3]}${m[1] ? ` (${m[1]})` : ''}`;
  }
  return undefined;
}

/** Normalizes any thrown value (CommandError, Node errno error, fetch error, string...) into a report. */
export function toErrorReport(err: unknown, step: string): ErrorReport {
  if (err instanceof CommandError) {
    return createErrorReport({
      step,
      message: err.summary,
      command: err.command,
      exitCode: err.exitCode,
      elevated: err.elevated,
      where: err.where,
      output: err.outputTail,
      details: err.details,
    });
  }
  if (err instanceof Error) {
    const details: string[] = [];
    const code = (err as NodeJS.ErrnoException).code;
    if (code) details.push(`Error code: ${code}`);
    if (err instanceof AggregateError) for (const e of err.errors) details.push(`- ${describeError(e)}`);
    let cause = (err as { cause?: unknown }).cause;
    for (let depth = 0; cause !== undefined && cause !== null && depth < 5; depth++) {
      details.push(`Caused by: ${describeError(cause)}`);
      cause = cause instanceof Error ? (cause as { cause?: unknown }).cause : undefined;
    }
    const frames = stackFrames(err.stack);
    if (frames.length > 0) details.push('Stack trace:', ...frames.map((f) => `  ${f}`));
    return createErrorReport({ step, message: err.message || err.name, where: whereFromStack(err.stack), details });
  }
  if (err === undefined || err === null) return createErrorReport({ step, message: 'Unknown error' });
  return createErrorReport({ step, message: typeof err === 'string' ? err : safeJson(err) });
}

const field = (name: string, value: string) => ` ${name.padEnd(13)} ${value}`;

/** The boxed FAILURE REPORT block (no trailing newline). */
export function formatFailureReport(r: ErrorReport, index: number, total: number): string {
  const lines = [RULE, ` FAILURE REPORT ${index} of ${total}: ${r.step}`, THIN_RULE, field('What failed', r.summary)];
  if (r.command) lines.push(field('Command', r.command));
  if (r.exitCode !== undefined) lines.push(field('Exit code', String(r.exitCode)));
  if (r.elevated) lines.push(field('Elevated', ELEVATION_LABELS[r.elevated] ?? `yes (${r.elevated})`));
  if (r.where) lines.push(field('Where', r.where));
  if (r.hint) lines.push(field('Hint', r.hint));
  if (r.output.length > 0) {
    const n = r.output.length;
    lines.push(r.outputTotal > n ? ` Last output (last ${n} of ${r.outputTotal} lines)` : ` Last output (${n} ${n === 1 ? 'line' : 'lines'})`);
    lines.push(...r.output.map((l) => `   | ${l}`));
  }
  if (r.details.length > 0) {
    lines.push(' Details');
    lines.push(...r.details.map((l) => `   | ${l}`));
  }
  return lines.map(redact).join('\n');
}

export interface HeaderFields {
  started: string;
  source: string;
  system: string;
  options: string;
  logFile: string;
}

export function formatHeader(h: HeaderFields): string {
  return [
    RULE,
    ' Docker + Ollama Installer log',
    field('Started', h.started),
    field('Source', h.source),
    field('System', h.system),
    field('Options', h.options),
    field('Log file', h.logFile),
    RULE,
  ]
    .map(redact)
    .join('\n');
}

/** Timeline columns: time, level, step, message. Continuation lines are indented under the message. */
export function formatTimelineLine(time: string, level: string, step: string, message: string): string {
  const lines = String(message).split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
  const first = `${time}  ${level.padEnd(5)}  ${step.padEnd(8)} ${lines[0] ?? ''}`;
  const rest = lines.slice(1).filter((l) => l.trim() !== '').map((l) => `${' '.repeat(30)}| ${l}`);
  return [first, ...rest].map(redact).join('\n');
}

export function formatDuration(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

export interface SummaryFields {
  results: Record<string, string>;
  notes: string[];
  exitCode: number;
  durationMs: number;
  cancelled: boolean;
}

export function formatSummary(s: SummaryFields): string {
  const lines = [RULE, ` SUMMARY   exit code ${s.exitCode}   (duration ${formatDuration(s.durationMs)})${s.cancelled ? '   cancelled' : ''}`];
  for (const [step, value] of Object.entries(s.results)) {
    lines.push(`   ${step.padEnd(8)} ${String(value).split(/\r?\n/)[0]}`);
  }
  if (s.notes.length > 0) {
    lines.push(' Next steps:');
    lines.push(...s.notes.map((n) => `   - ${n}`));
  }
  return lines.map(redact).join('\n');
}

/** Summary, then every failure report, then a closing rule. */
export function formatRunEnd(s: SummaryFields, reports: ErrorReport[]): string {
  return [formatSummary(s), ...reports.map((r, i) => formatFailureReport(r, i + 1, reports.length)), RULE].join('\n');
}
