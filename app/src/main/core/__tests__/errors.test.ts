import { describe, expect, it } from 'vitest';
import { CommandError, findHint, stackFrames, toErrorReport, whereFromStack } from '../errors';
import { execCommand, ScriptMarkers, SH_PREAMBLE } from '../platform';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('toErrorReport', () => {
  it('keeps the command, exit code, elevation and output of a CommandError', () => {
    const err = new CommandError({ command: 'apt-get install -y x', exitCode: 100, outputTail: ['E: Could not get lock /var/lib/dpkg/lock'], elevated: 'pkexec' });
    expect(err.message).toBe('Command failed (exit code 100): apt-get install -y x');
    const r = toErrorReport(err, 'Docker');
    expect(r).toMatchObject({ step: 'Docker', summary: 'Command failed (exit code 100)', command: 'apt-get install -y x', exitCode: 100, elevated: 'pkexec', hintId: 'dpkg-lock' });
    expect(r.output).toEqual(['E: Could not get lock /var/lib/dpkg/lock']);
  });

  it('adds the errno code, cause chain and a short stack for plain errors', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND ollama.com'), { code: 'ENOTFOUND' });
    const err = new TypeError('fetch failed', { cause });
    const r = toErrorReport(err, 'Ollama');
    expect(r.summary).toBe('fetch failed');
    expect(r.details).toContain('Caused by: Error [ENOTFOUND]: getaddrinfo ENOTFOUND ollama.com');
    expect(r.details).toContain('Stack trace:');
    expect(r.hintId).toBe('network');
    expect(r.where).toMatch(/errors\.test\.ts line \d+/);
  });

  it('handles AggregateError, strings and objects', () => {
    const agg = toErrorReport(new AggregateError([new Error('a'), 'b'], 'two things failed'), 'Models');
    expect(agg.details).toEqual(expect.arrayContaining(['- Error: a', '- b']));
    expect(toErrorReport('boom', 'Docker').summary).toBe('boom');
    expect(toErrorReport({ code: 42 }, 'Docker').summary).toBe('{"code":42}');
    expect(toErrorReport(undefined, 'Docker').summary).toBe('Unknown error');
  });

  it('reports a spawn failure as a missing program', async () => {
    const err = await execCommand('definitely-not-a-real-command-xyz').catch((e) => e);
    const r = toErrorReport(err, 'Ollama');
    expect(r.details).toContain('Error code: ENOENT');
    expect(r.hintId).toBe('command-not-found');
  });

  it('captures the last output lines of a failed command', async () => {
    const err = await execCommand('/bin/sh', ['-c', 'echo one; echo two >&2; exit 3']).catch((e) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect(err.exitCode).toBe(3);
    expect([...err.outputTail].sort()).toEqual(['one', 'two']);
  });
});

describe('hints and stacks', () => {
  it('matches exit codes and patterns', () => {
    expect(findHint('anything', 740)?.id).toBe('needs-admin');
    expect(findHint('connect ECONNREFUSED 127.0.0.1:11434')?.id).toBe('ollama-unreachable');
    expect(findHint('all good')).toBeUndefined();
  });

  it('shortens stack paths and finds our own frame', () => {
    const stack = [
      'Error: x',
      '    at installDocker (/Users/a/app/dist/main/core/docker.js:142:13)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
      '    at async /Users/a/app/dist/main/core/orchestrator.js:112:24',
      '    at async C:\\Program Files\\App\\resources\\app.asar\\dist\\main\\index.js:150:13',
    ].join('\n');
    expect(stackFrames(stack)[0]).toBe('at installDocker (docker.js:142:13)');
    expect(stackFrames(stack).slice(2)).toEqual(['at async orchestrator.js:112:24', 'at async index.js:150:13']);
    expect(whereFromStack(stack)).toBe('docker.js line 142 (installDocker)');
  });
});

describe('ScriptMarkers', () => {
  it('turns sh traces into "$ cmd" lines, hides echo traces and names the failing command', () => {
    const forwarded: string[] = [];
    const m = new ScriptMarkers((l) => forwarded.push(l));
    ['@@CMD apt-get update', 'Hit:1 http://archive.ubuntu.com', "@@CMD echo '@@NOTE hi'", '@@NOTE hi', '@@@CMD dpkg --print-architecture', '@@CMD apt-get install -y x', 'E: Could not get lock', '@@ERROR-EXIT 100'].forEach(m.push);
    expect(forwarded).toEqual(['$ apt-get update', 'Hit:1 http://archive.ubuntu.com', '@@NOTE hi', '$ dpkg --print-architecture', '$ apt-get install -y x', 'E: Could not get lock']);
    const err = m.toError(new CommandError({ command: 'pkexec /bin/sh /tmp/step.sh', exitCode: 100 }), 'pkexec') as CommandError;
    expect(err).toMatchObject({ command: 'apt-get install -y x', exitCode: 100, elevated: 'pkexec', summary: 'Command failed (exit code 100)' });
    expect(err.outputTail.at(-1)).toBe('E: Could not get lock');
  });

  it('reads the elevated PowerShell error markers', () => {
    const m = new ScriptMarkers();
    ['Downloading x', '@@ERROR Docker Desktop installer signature check failed (NotSigned, )', '@@ERROR-AT elevated script line 30: throw "x"', '@@ERROR-STACK at <ScriptBlock>, step.ps1: line 30'].forEach(m.push);
    const err = m.toError(new CommandError({ command: 'powershell.exe ...', exitCode: 1 }), 'uac') as CommandError;
    expect(err.summary).toBe('Docker Desktop installer signature check failed (NotSigned, )');
    expect(err.command).toBeUndefined();
    expect(err.exitCode).toBeUndefined();
    expect(err.where).toBe('elevated script line 30: throw "x"');
    expect(err.details).toEqual(['PowerShell stack:', '  at <ScriptBlock>, step.ps1: line 30']);
    expect(toErrorReport(err, 'Docker').hintId).toBe('signature-invalid');
  });

  it('turns a cancelled password prompt into a friendly error', () => {
    const m = new ScriptMarkers();
    const err = m.toError(new CommandError({ command: 'osascript', exitCode: 1, outputTail: ['execution error: User canceled. (-128)'] }), 'osascript');
    expect(err.message).toBe('The administrator password prompt was cancelled or denied.');
  });

  it('the sh preamble reports the failing command and its exit code (real /bin/sh)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markers-'));
    const file = path.join(dir, 'step.sh');
    fs.writeFileSync(file, `${SH_PREAMBLE}\necho hello\nif command -v nothere-xyz >/dev/null 2>&1; then echo no; fi\nls /nonexistent-dir-xyz\necho never\n`);
    let out = '';
    try {
      execFileSync('/bin/sh', [file], { encoding: 'utf8' });
    } catch (e) {
      out = (e as { stdout: string }).stdout;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const m = new ScriptMarkers();
    out.split('\n').filter(Boolean).forEach(m.push);
    expect(m.lastCommand).toBe('ls /nonexistent-dir-xyz');
    expect(m.exitCode).toBeGreaterThan(0);
    expect(m.tail).not.toContain('never');
  });
});
