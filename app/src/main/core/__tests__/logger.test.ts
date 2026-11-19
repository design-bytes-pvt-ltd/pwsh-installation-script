import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createErrorReport } from '../errors';
import { defaultLogDir, describeOptions, fileStamp, formatClock, formatStarted, InstallLogger, pruneOldLogs } from '../logger';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const header = { source: 'test', system: 'TestOS (amd64)   user: t   admin: no', options: 'ollama=yes  models=none  docker=no  engine=no  dry-run=yes', started: new Date(2026, 10, 18, 14, 2, 11) };

describe('InstallLogger', () => {
  it('writes header, timeline, summary and failure reports', () => {
    const file = path.join(tmp(), 'nested', 'install-x.log');
    const logger = new InstallLogger(file, header);
    logger.event({ type: 'step', step: 'Ollama', status: 'running' });
    logger.event({ type: 'log', level: 'info', message: 'Downloading https://u:pw@example.com/x', timestamp: '' });
    logger.event({ type: 'log', level: 'info', message: '>>> Installing', timestamp: '', output: true });
    logger.event({ type: 'progress', step: 'Ollama', label: 'chatty' });
    logger.failure(createErrorReport({ step: 'Models: nope:1b', message: 'pull model manifest: file does not exist' }));
    logger.event({ type: 'note', message: 'Open Docker Desktop once.' });
    logger.event({ type: 'summary', results: { Ollama: 'installed', Models: 'FAILED: Failed to pull: nope:1b' }, notes: ['Open Docker Desktop once.'], exitCode: 1, cancelled: false });

    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain(' Docker + Ollama Installer log');
    expect(text).toContain(' Started       2026-11-18 14:02:11 ');
    expect(text).toMatch(/\d\d:\d\d:\d\d\.\d{3} {2}STEP {3}Ollama {3}running/);
    expect(text).toMatch(/INFO {3}Ollama {3}Downloading https:\/\/\*\*\*:\*\*\*@example\.com\/x/);
    expect(text).toMatch(/OUT {4}Ollama {3}>>> Installing/);
    expect(text).not.toContain('chatty');
    expect(text).toMatch(/ERROR {2}Models {3}pull model manifest: file does not exist\n {30}\| Hint: Ollama could not find/);
    expect(text).toContain(' SUMMARY   exit code 1');
    expect(text).toContain(' FAILURE REPORT 1 of 1: Models: nope:1b');
    expect(text.trimEnd().endsWith('='.repeat(80))).toBe(true);
    expect(logger.reportText()).toContain('FAILURE REPORT 1 of 1');
  });

  it('writes crash reports immediately', () => {
    const file = path.join(tmp(), 'crash.log');
    const logger = new InstallLogger(file, header);
    const r = logger.crash('Uncaught exception', new Error('kaboom'));
    expect(r.summary).toBe('kaboom');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('ERROR  crash    Uncaught exception: kaboom');
    expect(text).toContain(' FAILURE REPORT 1 of 1: Uncaught exception');
    expect(logger.reportText()).toBe('');
  });

  it('never throws when the log cannot be written', () => {
    const blocker = path.join(tmp(), 'a-file');
    fs.writeFileSync(blocker, '');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new InstallLogger(path.join(blocker, 'sub', 'install.log'), header);
    expect(() => {
      logger.event({ type: 'step', step: 'Docker', status: 'running' });
      logger.failure(createErrorReport({ step: 'Docker', message: 'x' }));
      logger.crash('Uncaught exception', new Error('y'));
      logger.event({ type: 'summary', results: {}, notes: [], exitCode: 1, cancelled: false });
    }).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1); // warns once, then stays quiet
  });
});

describe('log helpers', () => {
  it('keeps only the newest logs', () => {
    const dir = tmp();
    for (let i = 0; i < 13; i++) {
      const f = path.join(dir, `install-${i}.log`);
      fs.writeFileSync(f, '');
      fs.utimesSync(f, new Date(2026, 0, 1, 0, i), new Date(2026, 0, 1, 0, i));
    }
    fs.writeFileSync(path.join(dir, 'other.txt'), '');
    pruneOldLogs(dir, 10);
    const left = fs.readdirSync(dir).sort();
    expect(left).toContain('other.txt');
    expect(left.filter((f) => f.endsWith('.log'))).toHaveLength(10);
    expect(left).not.toContain('install-0.log');
    expect(() => pruneOldLogs(path.join(dir, 'missing'))).not.toThrow();
  });

  it('uses the OS log folder', () => {
    expect(defaultLogDir('darwin', {}, '/Users/a')).toBe('/Users/a/Library/Logs/Docker + Ollama Installer');
    expect(defaultLogDir('linux', {}, '/home/a')).toBe('/home/a/.config/Docker + Ollama Installer/logs');
    expect(defaultLogDir('linux', { XDG_CONFIG_HOME: '/x' }, '/home/a')).toBe('/x/Docker + Ollama Installer/logs');
    expect(defaultLogDir('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a')).toBe('C:\\Users\\a\\AppData\\Roaming\\Docker + Ollama Installer\\logs');
  });

  it('formats times and options', () => {
    const d = new Date(2026, 10, 8, 4, 5, 6, 7);
    expect(formatClock(d)).toBe('04:05:06.007');
    expect(fileStamp(d)).toBe('20261108-040506');
    expect(formatStarted(d)).toMatch(/^2026-11-08 04:05:06 [+-]\d\d:\d\d$/);
    expect(describeOptions({ installOllama: true, installDocker: false, dockerEngineOnLinux: false, models: ['a', 'b'], dryRun: true })).toBe(
      'ollama=yes  models=a,b  docker=no  engine=no  dry-run=yes'
    );
  });
});
