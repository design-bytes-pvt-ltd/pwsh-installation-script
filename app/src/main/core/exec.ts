import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { CommandError } from './errors';

export interface ExecOptions {
  signal?: AbortSignal;
  onOutput?: (line: string) => void;
  allowedExitCodes?: number[];
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. Use it for secrets (never put them in args). */
  input?: string;
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
export const TAIL_LINES = 40;

export function pushTail(tail: string[], line: string): void {
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
      stdio: [options.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
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

    if (options.input !== undefined && child.stdin) {
      // The child may exit before reading everything; that surfaces as its exit code, not EPIPE.
      child.stdin.on('error', () => {});
      child.stdin.end(options.input);
    }

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
