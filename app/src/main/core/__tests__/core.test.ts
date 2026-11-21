import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeDiskInfo, computeModelBudget, diskCheckPath, parseNvidiaSmiOutput, parseRocmSmiJson, REQUIRED_DISK_GB } from '../hardware';
import { pullMissingModels } from '../orchestrator';
import { buildModelRows, getModelMinMemory, getModelTier, getOllamaBaseUrl, loadModelCatalog, normalizeModelKey } from '../models';
import { buildEngineScript, buildWindowsDockerScript } from '../docker';
import { parsePullLine } from '../ollama';
import { execCommand, LineSplitter } from '../exec';
import {
  buildComposeArgs,
  dockerCliCandidates,
  dockerEnv,
  formatBytes,
  loadRegistryCredentials,
  parseComposeProgress,
  parseContainerState,
  PullProgressTracker,
  resolveDockerCli,
} from '../containers';
import { findHint, redact } from '../errors';
import { DEFAULT_LAUNCH_URL, isWebUrl, loadLaunchUrl } from '../appConfig';
import { getTargetUser, isWindowsArm64, parseOsRelease, quoteAppleScript, quotePs, quoteSh } from '../platform';

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

describe('disk space', () => {
  it('computes free GB from statfs numbers or bigints', () => {
    expect(computeDiskInfo({ bavail: 25 * 1024 ** 2, bsize: 4096 }, '/home/u')).toEqual({
      path: '/home/u',
      freeGB: 100,
      requiredGB: REQUIRED_DISK_GB,
    });
    expect(computeDiskInfo({ bavail: BigInt(1024 ** 2), bsize: BigInt(4096) }, 'C:\\').freeGB).toBe(4);
  });

  it('measures the system drive on Windows and the home folder elsewhere', () => {
    expect(diskCheckPath('windows', { SystemDrive: 'D:' })).toBe('D:\\');
    expect(diskCheckPath('windows', {})).toBe('C:\\');
    expect(diskCheckPath('macos')).toBe(os.homedir());
  });
});

describe('pullMissingModels', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Fakes Ollama: /api/tags lists `installed`; /api/pull streams a successful pull. */
  const fakeOllama = (installed: string[]) => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: installed.map((name) => ({ name, size: 1024 ** 3 })) }));
      }
      if (url.endsWith('/api/pull')) return new Response('{"status":"pulling"}\n{"status":"success"}\n');
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const pullCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/pull')).map(([, init]) => JSON.parse(init.body).model);

  it('does not pull a model that is already downloaded', async () => {
    const fetchMock = fakeOllama(['llama3.2:3b']);
    const result = await pullMissingModels(['llama3.2:3b'], 'http://ollama', () => {}, () => {});
    expect(result).toEqual({ pulled: [], skipped: ['llama3.2:3b'], failed: [] });
    expect(pullCalls(fetchMock)).toEqual([]);
  });

  it('matches an installed model regardless of the :latest tag', async () => {
    const fetchMock = fakeOllama(['phi4-mini:latest']);
    const result = await pullMissingModels(['phi4-mini', 'qwen3:4b'], 'http://ollama', () => {}, () => {});
    expect(result).toEqual({ pulled: ['qwen3:4b'], skipped: ['phi4-mini'], failed: [] });
    expect(pullCalls(fetchMock)).toEqual(['qwen3:4b']);
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

  it('keeps only the last frame of spinners that redraw with ESC[<n>G', () => {
    expect(collect(['\x1b[?25l\x1b[1Gpulling manifest ⠋ \x1b[K\x1b[1Gpulling manifest ⠙ \x1b[K\x1b[1Gpulling manifest \x1b[K\x1b[?25h\n'])).toEqual([
      'pulling manifest',
    ]);
  });

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

describe('execCommand input', () => {
  it('writes input to stdin', async () => {
    const res = await execCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
      input: 'secret-token\n',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(res.stdout.trim()).toBe('secret-token');
  });
});

describe('containers', () => {
  it('prefers the Docker Desktop CLI on macOS and falls back to PATH', () => {
    const env = { HOME: '/Users/me' };
    expect(dockerCliCandidates('macos', env)).toContain('/Users/me/.docker/bin/docker');
    expect(resolveDockerCli('macos', (p) => p === '/usr/local/bin/docker', env)).toBe('/usr/local/bin/docker');
    expect(resolveDockerCli('linux', () => false, env)).toBe('docker');
    expect(resolveDockerCli('windows', () => true, { ProgramFiles: 'D:\\Apps' })).toBe('D:\\Apps\\Docker\\Docker\\resources\\bin\\docker.exe');
  });

  it('puts the CLI directory first on PATH (keeping Windows "Path")', () => {
    expect(dockerEnv('/Applications/Docker.app/Contents/Resources/bin/docker', { PATH: '/usr/bin' }, 'macos').PATH).toBe(
      '/Applications/Docker.app/Contents/Resources/bin:/usr/bin'
    );
    const win = dockerEnv('C:\\Docker\\bin\\docker.exe', { Path: 'C:\\Windows' }, 'windows');
    expect(win.Path).toBe('C:\\Docker\\bin;C:\\Windows');
    expect(win.PATH).toBeUndefined();
    expect(dockerEnv('docker', { PATH: '/usr/bin' }, 'linux').PATH).toBe('/usr/bin');
  });

  it('reads the dev container state', () => {
    expect(parseContainerState({ ok: true, stdout: 'true\n' })).toBe('running');
    expect(parseContainerState({ ok: true, stdout: 'false\n' })).toBe('stopped');
    expect(parseContainerState({ ok: false, output: 'Error response from daemon: No such container: ubuntu-nix-hm' })).toBe('missing');
    expect(parseContainerState({ ok: false, output: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' })).toBe('unknown');
    expect(parseContainerState({ ok: false, output: 'failed to connect to the docker API at unix:///x/docker.sock: no such file or directory' })).toBe('unknown');
  });

  it('builds compose arguments with a fixed project name', () => {
    expect(buildComposeArgs('/r/compose.yml', 'up', '-d')).toEqual(['compose', '-f', '/r/compose.yml', '-p', 'enterprise-brain', 'up', '-d']);
  });

  describe('loadRegistryCredentials', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcr-creds-'));
    const good = path.join(dir, 'good.json');
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(good, JSON.stringify({ username: 'bot', token: ' ghp_x ' }));
    fs.writeFileSync(bad, '{not json');

    it('reads the first valid file', () => {
      expect(loadRegistryCredentials([path.join(dir, 'missing.json'), bad, good], {})).toEqual({ username: 'bot', token: 'ghp_x' });
    });

    it('lets GHCR_USERNAME / GHCR_TOKEN win', () => {
      expect(loadRegistryCredentials([good], { GHCR_USERNAME: 'me', GHCR_TOKEN: 't' })).toEqual({ username: 'me', token: 't' });
    });

    it('returns null when nothing is configured', () => {
      expect(loadRegistryCredentials([bad], { GHCR_USERNAME: 'me' })).toBeNull();
    });
  });

  it('picks hints for Docker and registry failures', () => {
    expect(findHint('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock')?.id).toBe(
      'docker-permission'
    );
    expect(findHint('Docker did not become ready within 3 minutes.')?.id).toBe('docker-unreachable');
    expect(findHint('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?')?.id).toBe(
      'docker-unreachable'
    );
    expect(findHint('Error response from daemon: Head "https://ghcr.io/v2/design-bytes-pvt-ltd/ubuntu-nix-hm/manifests/latest": unauthorized')?.id).toBe(
      'registry-denied'
    );
    expect(findHint('error from registry: denied')?.id).toBe('registry-denied');
    expect(
      findHint('failed to connect to the docker API at unix:///Users/me/.docker/run/docker.sock; dial unix: connect: no such file or directory')?.id
    ).toBe('docker-unreachable');
  });

  it('redacts GitHub tokens', () => {
    expect(redact('login with ghp_abcdefghijklmnopqrstuvwxyz0123 failed')).toBe('login with *** failed');
    expect(redact('github_pat_11ABCDEFG0123456789_abcdefghij')).toBe('***');
  });
});

describe('launch URL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-config-'));
  const write = (name: string, body: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    return file;
  };

  it('accepts only http(s) links', () => {
    expect(isWebUrl('https://example.com/x')).toBe(true);
    expect(isWebUrl('http://localhost:3000')).toBe(true);
    expect(isWebUrl('file:///etc/passwd')).toBe(false);
    expect(isWebUrl('javascript:alert(1)')).toBe(false);
    expect(isWebUrl('not a url')).toBe(false);
    expect(isWebUrl(42)).toBe(false);
  });

  it('reads launchUrl from the config, with the env var winning', () => {
    const config = write('ok.json', JSON.stringify({ launchUrl: ' https://brain.example.com ' }));
    expect(loadLaunchUrl(config, {})).toBe('https://brain.example.com');
    expect(loadLaunchUrl(config, { ENTERPRISE_BRAIN_URL: 'http://localhost:8080' })).toBe('http://localhost:8080');
  });

  it('falls back to the default for a missing, invalid or unsafe config', () => {
    expect(loadLaunchUrl(path.join(dir, 'missing.json'), {})).toBe(DEFAULT_LAUNCH_URL);
    expect(loadLaunchUrl(write('bad.json', '{oops'), {})).toBe(DEFAULT_LAUNCH_URL);
    expect(loadLaunchUrl(write('file.json', JSON.stringify({ launchUrl: 'file:///etc/passwd' })), {})).toBe(DEFAULT_LAUNCH_URL);
  });
});

describe('dev container pull progress', () => {
  // Captured from `docker compose --progress json pull` (Compose v5.6), plus a second layer.
  const lines = [
    '{"id":"Image debian:bookworm-slim","status":"Working","text":"Pulling"}',
    '{"id":"2d66c782e484","parent_id":"Image debian:bookworm-slim","status":"Working","text":"Pulling fs layer","details":"0B"}',
    '{"id":"9e2a41483b7f","parent_id":"Image debian:bookworm-slim","status":"Done","text":"Download complete","details":"0B","percent":100}',
    '{"id":"2d66c782e484","parent_id":"Image debian:bookworm-slim","status":"Working","text":"Downloading","details":"1.049MB","current":1048576,"total":28144358,"percent":3}',
    '{"id":"aaaaaaaaaaaa","parent_id":"Image debian:bookworm-slim","status":"Working","text":"Downloading","details":"0B","current":0,"total":71855642,"percent":0}',
    '{"id":"2d66c782e484","parent_id":"Image debian:bookworm-slim","status":"Done","text":"Download complete","details":"0B","percent":100}',
    '{"id":"aaaaaaaaaaaa","parent_id":"Image debian:bookworm-slim","status":"Done","text":"Download complete","details":"0B","percent":100}',
    '{"id":"2d66c782e484","parent_id":"Image debian:bookworm-slim","status":"Working","text":"Extracting","details":"1B","current":1}',
  ];

  it('formats bytes in decimal units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(850_000)).toBe('850 KB');
    expect(formatBytes(3_145_728)).toBe('3.1 MB');
    expect(formatBytes(312_400_000)).toBe('312 MB');
    expect(formatBytes(1_214_000_000)).toBe('1.21 GB');
  });

  it('parses JSON lines and ignores plain output', () => {
    expect(parseComposeProgress(lines[0])).toEqual({ id: 'Image debian:bookworm-slim', status: 'Working', text: 'Pulling' });
    expect(parseComposeProgress('Error response from daemon: error from registry: unauthorized')).toBeNull();
    expect(parseComposeProgress('{broken')).toBeNull();
  });

  it('adds up layers into MB of MB, then reports unpacking', () => {
    const tracker = new PullProgressTracker();
    const statuses = lines.map((l) => tracker.update(parseComposeProgress(l)!));
    // Image lines, "Pulling fs layer" and a completed layer of unknown size change nothing.
    expect(statuses.slice(0, 3)).toEqual([null, null, null]);
    expect(statuses[3]).toEqual({ label: 'Downloading the dev container: 1.0 MB of 28 MB', percent: 3 });
    // A second layer starts: the total grows, but the bar does not go back.
    expect(statuses[4]).toEqual({ label: 'Downloading the dev container: 1.0 MB of 100 MB', percent: 3 });
    expect(statuses[5]).toEqual({ label: 'Downloading the dev container: 28 MB of 100 MB', percent: 28 });
    expect(statuses[6]).toEqual({ label: 'Downloading the dev container: 100 MB of 100 MB', percent: 100 });
    expect(statuses[7]).toEqual({ label: 'Unpacking the dev container...', percent: 100 });
    expect(tracker.downloadedBytes).toBe(100_000_000);
  });
});
