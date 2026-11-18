import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeModelBudget, parseNvidiaSmiOutput, parseRocmSmiJson } from '../hardware';
import { buildModelRows, getModelMinMemory, getModelTier, getOllamaBaseUrl, loadModelCatalog, normalizeModelKey } from '../models';
import { buildEngineScript, buildWindowsDockerScript } from '../docker';
import { parsePullLine } from '../ollama';
import { getTargetUser, isWindowsArm64, LineSplitter, parseOsRelease, quoteAppleScript, quotePs, quoteSh } from '../platform';

describe('hardware', () => {
  it('parses nvidia-smi MiB output into GB', () => {
    expect(parseNvidiaSmiOutput('8192\n16384\n')).toBe(16);
    expect(parseNvidiaSmiOutput('N/A')).toBeNull();
  });

  it('parses rocm-smi JSON VRAM output into GB', () => {
    const json = JSON.stringify({ card0: { 'VRAM Total Memory (B)': String(8 * 1024 ** 3) } });
    expect(parseRocmSmiJson(json)).toBe(8);
    expect(parseRocmSmiJson('invalid')).toBeNull();
  });

  it('computes budget for GPU, Apple silicon, and CPU', () => {
    expect(computeModelBudget(32, { vendor: 'NVIDIA', vramGB: 12 }, 'linux', 'amd64')).toEqual({
      budgetGB: 12,
      ramGB: 32,
      source: 'NVIDIA GPU with 12 GB VRAM',
    });
    expect(computeModelBudget(16, null, 'macos', 'arm64')).toEqual({
      budgetGB: 10.4,
      ramGB: 16,
      source: 'Apple silicon with 16 GB unified memory',
    });
    expect(computeModelBudget(16, null, 'linux', 'amd64')).toEqual({
      budgetGB: 8,
      ramGB: 16,
      source: 'CPU with 16 GB RAM',
    });
  });
});

describe('models', () => {
  it('normalizes model keys consistently', () => {
    expect(normalizeModelKey('phi4-mini')).toBe('phi4-mini:latest');
    expect(normalizeModelKey('registry.ollama.ai/library/phi4-mini:latest')).toBe('phi4-mini:latest');
    expect(normalizeModelKey('  Qwen3:8B ')).toBe('qwen3:8b');
  });

  it('computes min memory and tiers', () => {
    expect(getModelMinMemory({ name: 'a', size_gb: 4 })).toBe(6);
    expect(getModelMinMemory({ name: 'a', size_gb: 4, min_memory_gb: 7 })).toBe(7);

    const budget = { budgetGB: 8, ramGB: 16, source: 'test' };
    expect(getModelTier({ name: 'a', min_memory_gb: 8 }, budget)).toBe('recommended');
    expect(getModelTier({ name: 'b', min_memory_gb: 12 }, budget)).toBe('may be slow');
    expect(getModelTier({ name: 'c', min_memory_gb: 20 }, budget)).toBe('too large');
  });

  it('normalizes OLLAMA_HOST', () => {
    expect(getOllamaBaseUrl('')).toBe('http://127.0.0.1:11434');
    expect(getOllamaBaseUrl('0.0.0.0:11434')).toBe('http://127.0.0.1:11434');
    expect(getOllamaBaseUrl('10.0.0.5')).toBe('http://10.0.0.5:11434');
    expect(getOllamaBaseUrl('https://ollama.internal:8443')).toBe('https://ollama.internal:8443');
  });

  it('loads models.json and falls back on missing/invalid files', () => {
    const repoModels = path.resolve(__dirname, '../../../../../models.json');
    const catalog = loadModelCatalog(repoModels);
    // Compare with the file itself: a count of 1 would mean we silently got the fallback.
    const expected = JSON.parse(fs.readFileSync(repoModels, 'utf8')).models.length;
    expect(expected).toBeGreaterThan(1);
    expect(catalog.length).toBe(expected);

    const tmpFile = path.join(os.tmpdir(), `bad-models-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, '{bad');
    expect(loadModelCatalog(tmpFile)[0].name).toBe('qwen3:0.6b');
    fs.rmSync(tmpFile, { force: true });
  });

  it('builds rows with default largest recommended model and extra installed models', () => {
    const catalog = [
      { name: 'small:1b', size_gb: 1, min_memory_gb: 2 },
      { name: 'med:7b', size_gb: 4.5, min_memory_gb: 7 },
      { name: 'big:20b', size_gb: 14, min_memory_gb: 18 },
    ];
    const installed = new Map([['custom:latest', { name: 'custom:latest', sizeGB: 3.2 }]]);
    const rows = buildModelRows(catalog, installed, { budgetGB: 8, ramGB: 16, source: 'test' });
    expect(rows.find((r) => r.name === 'med:7b')?.isDefault).toBe(true);
    expect(rows.find((r) => r.name === 'custom')?.installed).toBe(true);
  });
});

describe('platform', () => {
  it('parses /etc/os-release content', () => {
    const parsed = parseOsRelease('ID=ubuntu\nID_LIKE=debian\nVERSION_CODENAME="noble"\n');
    expect(parsed.ID).toBe('ubuntu');
    expect(parsed.ID_LIKE).toBe('debian');
    expect(parsed.VERSION_CODENAME).toBe('noble');
  });
});

describe('LineSplitter', () => {
  const collect = (chunks: string[]) => {
    const lines: string[] = [];
    const splitter = new LineSplitter((l) => lines.push(l));
    chunks.forEach((c) => splitter.push(c));
    splitter.flush();
    return lines;
  };

  it('joins lines split across chunks', () => {
    expect(collect(['hel', 'lo\nwor', 'ld\n'])).toEqual(['hello', 'world']);
  });

  it('keeps only the final frame of \\r progress output and handles CRLF', () => {
    expect(collect(['  10%\r  50%\r 100%\r\n', 'done\r\n'])).toEqual([' 100%', 'done']);
  });

  it('strips ANSI colors, backspaces and a BOM', () => {
    expect(collect(['\uFEFF\x1b[32mok\x1b[0m\n', 'spin|\b/\n'])).toEqual(['ok', 'spin/']);
  });

  it('flushes a trailing line without a newline', () => {
    expect(collect(['last line'])).toEqual(['last line']);
  });
});

describe('quoting', () => {
  it('quotes for sh, PowerShell and AppleScript', () => {
    expect(quoteSh("it's")).toBe(`'it'\\''s'`);
    expect(quotePs("O'Brien")).toBe(`'O''Brien'`);
    expect(quoteAppleScript('say "hi" \\ bye')).toBe('"say \\"hi\\" \\\\ bye"');
  });
});

describe('getTargetUser / isWindowsArm64', () => {
  it('uses DOMAIN\\user on Windows and SUDO_USER on Unix', () => {
    expect(getTargetUser({ USERNAME: 'ann', USERDOMAIN: 'CORP' }, 'windows')).toBe('CORP\\ann');
    expect(getTargetUser({ USERNAME: 'ann' }, 'windows')).toBe('ann');
    expect(getTargetUser({ USER: 'root', SUDO_USER: 'ann' }, 'linux')).toBe('ann');
  });

  it('detects ARM64 Windows under x64 emulation', () => {
    expect(isWindowsArm64({ PROCESSOR_ARCHITECTURE: 'AMD64', PROCESSOR_IDENTIFIER: 'ARMv8 (64-bit) Family 8' })).toBe(true);
    expect(isWindowsArm64({ PROCESSOR_ARCHITECTURE: 'AMD64', PROCESSOR_IDENTIFIER: 'Intel64 Family 6' })).toBe(false);
  });
});

describe('parsePullLine', () => {
  it('computes percent and surfaces errors', () => {
    expect(parsePullLine('{"status":"pulling abc","completed":50,"total":200}')).toMatchObject({ status: 'pulling abc', percent: 25 });
    expect(parsePullLine('{"status":"success"}').status).toBe('success');
    expect(() => parsePullLine('{"error":"pull model manifest: file does not exist"}')).toThrow(/file does not exist/);
  });
});

describe('privileged scripts', () => {
  it('Engine script keeps going when the group or service step fails', () => {
    const script = buildEngineScript('/tmp/x/get-docker.sh', "o'neil");
    expect(script).toContain(`sh '/tmp/x/get-docker.sh'`);
    expect(script).toContain(`usermod -aG docker 'o'\\''neil'`);
    expect(script).toMatch(/systemctl enable --now docker \|\| echo/);
  });

  it('Windows script installs WSL only when needed and uses Add-LocalGroupMember', () => {
    const withWsl = buildWindowsDockerScript({ installWsl: true, arch: 'amd64', targetUser: "CORP\\o'neil" });
    expect(withWsl).toContain("'--install', '--no-distribution'");
    expect(withWsl).toContain("$user = 'CORP\\o''neil'");
    expect(withWsl).toContain('Add-LocalGroupMember');
    expect(withWsl).not.toContain('net localgroup');
    expect(buildWindowsDockerScript({ installWsl: false, arch: 'arm64', targetUser: 'ann' })).not.toContain('wsl.exe');
  });
});
