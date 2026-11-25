import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { detectDocker } from './docker';
import {
  encodeRegistryAuth,
  EngineUnavailableError,
  engineError,
  isLayerId,
  type OpenPullStream,
  pullImageViaEngine,
  PullStalledError,
  readDockerLogin,
  resolveDockerSocket,
  type WatchdogLimits,
} from './enginePull';
import { CommandError } from './errors';
import { logEvent, networkReporter } from './events';
import { execCommand } from './exec';
import { formatBytes, formatElapsed } from './format';
import { checkConnectivity, errorText, isRetryableError, isRetryableText, OfflineError, type RetryOptions, withNetworkRetry } from './network';
import { getTargetOS } from './platform';
import type { DevContainerStatus, DockerKind, InstallEvent, TargetOS } from '../../shared/types';

export const REGISTRY = 'ghcr.io';
/** Compose project name, so re-runs (Retry) update the same containers instead of creating new ones. */
export const COMPOSE_PROJECT = 'enterprise-brain';

/** Must match `container_name` in containers/docker-compose.yml. */
export const DEV_CONTAINER_NAME = 'ubuntu-nix-hm';

const DOCKER_READY_TIMEOUT_MS = 180_000;
const DOCKER_POLL_MS = 3_000;

export interface RegistryCredentials {
  username: string;
  token: string;
}

/** Where the docker CLI usually lives. GUI apps on macOS get a minimal PATH, so look there first. */
export function dockerCliCandidates(targetOS: TargetOS, env: NodeJS.ProcessEnv = process.env): string[] {
  if (targetOS === 'windows') {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    return [path.win32.join(pf, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')];
  }
  if (targetOS === 'macos') {
    const home = env.HOME ?? '';
    return [
      '/Applications/Docker.app/Contents/Resources/bin/docker',
      ...(home ? [`${home}/.docker/bin/docker`] : []),
      '/usr/local/bin/docker',
      '/opt/homebrew/bin/docker',
    ];
  }
  return ['/usr/bin/docker', '/usr/local/bin/docker', '/opt/docker-desktop/bin/docker'];
}

/** The first docker CLI that exists, else plain "docker" (resolved through PATH). */
export function resolveDockerCli(
  targetOS: TargetOS,
  exists: (p: string) => boolean = fs.existsSync,
  env: NodeJS.ProcessEnv = process.env
): string {
  return dockerCliCandidates(targetOS, env).find((p) => exists(p)) ?? 'docker';
}

/**
 * The environment for running the docker CLI: its own directory goes first on PATH so that
 * `docker login` finds the credential helpers (docker-credential-desktop / -osxkeychain) next to it.
 */
export function dockerEnv(cli: string, env: NodeJS.ProcessEnv = process.env, targetOS: TargetOS = getTargetOS()): NodeJS.ProcessEnv {
  const pathApi = targetOS === 'windows' ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(cli)) return { ...env };
  // Windows spells it "Path"; keep whichever key the environment already uses.
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[key];
  const dir = pathApi.dirname(cli);
  return { ...env, [key]: current ? `${dir}${pathApi.delimiter}${current}` : dir };
}

/** Docker compose arguments for the bundled file and fixed project name. */
export function buildComposeArgs(composePath: string, ...sub: string[]): string[] {
  return ['compose', '-f', composePath, '-p', COMPOSE_PROJECT, ...sub];
}

function parseCredentials(raw: unknown): RegistryCredentials | null {
  if (!raw || typeof raw !== 'object') return null;
  const { username, token } = raw as Record<string, unknown>;
  if (typeof username !== 'string' || typeof token !== 'string') return null;
  if (!username.trim() || !token.trim()) return null;
  return { username: username.trim(), token: token.trim() };
}

/**
 * Registry credentials for ghcr.io: GHCR_USERNAME / GHCR_TOKEN from the environment win (dev),
 * then the first readable, valid JSON file. Returns null when none are configured.
 */
export function loadRegistryCredentials(files: string[], env: NodeJS.ProcessEnv = process.env): RegistryCredentials | null {
  const fromEnv = parseCredentials({ username: env.GHCR_USERNAME, token: env.GHCR_TOKEN });
  if (fromEnv) return fromEnv;
  for (const file of files) {
    try {
      const creds = parseCredentials(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (creds) return creds;
    } catch {
      // Missing or invalid file: try the next one.
    }
  }
  return null;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

type DockerInfo = { ok: true; version: string } | { ok: false; output: string[] };

async function dockerInfo(cli: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<DockerInfo> {
  try {
    const res = await execCommand(cli, ['info', '--format', '{{.ServerVersion}}'], { env, signal });
    const version = res.stdout.trim();
    // Older CLIs print the client part and exit 0 with an empty server version when the daemon is down.
    if (version) return { ok: true, version };
    return { ok: false, output: res.stderr.split(/\r?\n/).filter((l) => l.trim()) };
  } catch (err) {
    if (signal?.aborted) throw new Error('Cancelled');
    if (err instanceof CommandError) return { ok: false, output: err.outputTail };
    return { ok: false, output: [(err as Error)?.message ?? String(err)] };
  }
}

/** Launches Docker Desktop (or its Linux user service). Best effort: failures show up as a timeout. */
async function startDocker(
  targetOS: TargetOS,
  kind: DockerKind,
  log: (level: 'info' | 'warn', message: string) => void,
  signal?: AbortSignal
): Promise<void> {
  try {
    if (targetOS === 'macos') {
      log('info', 'Starting Docker Desktop...');
      // Not `-g`: Docker Desktop comes to the front while it starts; see dismissDockerDesktop.
      await execCommand('open', ['-a', 'Docker'], { signal });
    } else if (targetOS === 'windows') {
      const pf = process.env.ProgramFiles || 'C:\\Program Files';
      const exe = path.win32.join(pf, 'Docker', 'Docker', 'Docker Desktop.exe');
      log('info', 'Starting Docker Desktop...');
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', (err) => log('warn', `Could not start Docker Desktop: ${err.message}`));
      child.unref();
    } else if (kind === 'desktop') {
      log('info', 'Starting Docker Desktop (systemctl --user start docker-desktop)...');
      await execCommand('systemctl', ['--user', 'start', 'docker-desktop'], { signal });
    }
    // Docker Engine on Linux runs as a system service that the install already enabled.
  } catch (err) {
    if (signal?.aborted) throw new Error('Cancelled');
    log('warn', `Could not start Docker: ${(err as Error)?.message ?? String(err)}`);
  }
}

/**
 * Hides the Docker Desktop window once Docker is running, leaving Docker itself running. Best effort.
 * macOS asks the user once to let the installer control System Events; Windows sends Docker
 * Desktop to the tray. Linux has no reliable way to close another app's window, so it is left alone.
 */
export async function dismissDockerDesktop(
  targetOS: TargetOS,
  log: (level: 'info' | 'warn', message: string) => void = () => {}
): Promise<void> {
  try {
    if (targetOS === 'macos') {
      await execCommand('osascript', [
        '-e',
        `tell application "System Events" to set visible of (every process whose name is "${DOCKER_DESKTOP_PROCESS}") to false`,
      ]);
    } else if (targetOS === 'windows') {
      await execCommand('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-Process -Name '${DOCKER_DESKTOP_PROCESS}' -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }`,
      ]);
    }
  } catch (err) {
    log('warn', `Could not hide the Docker Desktop window: ${(err as Error)?.message ?? String(err)}`);
  }
}

/** Docker Desktop's UI process name on macOS and Windows. */
const DOCKER_DESKTOP_PROCESS = 'Docker Desktop';

/** Windows: name of the process that owns the foreground window. */
const WINDOWS_FOREGROUND_PROCESS_SCRIPT = [
  "Add-Type -Namespace EbInstaller -Name User32 -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);'",
  '$p = 0',
  '[void][EbInstaller.User32]::GetWindowThreadProcessId([EbInstaller.User32]::GetForegroundWindow(), [ref]$p)',
  '(Get-Process -Id $p).ProcessName',
].join('; ');

/**
 * Whether Docker Desktop is the app in front. False when unsure (Linux, or macOS without permission
 * to ask System Events), so callers never pull focus away from an app the user chose.
 */
export async function isDockerDesktopFrontmost(targetOS: TargetOS): Promise<boolean> {
  try {
    let name = '';
    if (targetOS === 'macos') {
      const res = await execCommand('osascript', [
        '-e',
        'tell application "System Events" to get name of first application process whose frontmost is true',
      ]);
      name = res.stdout;
    } else if (targetOS === 'windows') {
      const res = await execCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_FOREGROUND_PROCESS_SCRIPT]);
      name = res.stdout;
    }
    return name.trim() === DOCKER_DESKTOP_PROCESS;
  } catch {
    return false;
  }
}

/** Waits until the Docker daemon answers, starting Docker Desktop first if needed. Returns its version. */
export async function waitForDocker(options: {
  cli: string;
  env: NodeJS.ProcessEnv;
  targetOS: TargetOS;
  kind: DockerKind;
  emit: (event: InstallEvent) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  /** Runs once Docker, started by this call, is ready (not when it was already running). Errors are only logged. */
  onStarted?: () => void | Promise<void>;
}): Promise<string> {
  const { cli, env, signal, emit } = options;
  const log = (level: 'info' | 'warn', message: string) => emit(logEvent(message, level));

  let info = await dockerInfo(cli, env, signal);
  if (info.ok) return info.version;

  await startDocker(options.targetOS, options.kind, log, signal);
  emit({ type: 'progress', step: 'Containers', label: 'Waiting for Docker to start...' });
  log('info', 'Waiting for Docker to start...');

  const deadline = Date.now() + (options.timeoutMs ?? DOCKER_READY_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await delay(options.pollMs ?? DOCKER_POLL_MS, signal);
    info = await dockerInfo(cli, env, signal);
    if (info.ok) {
      if (options.onStarted) {
        try {
          await options.onStarted();
        } catch (err) {
          log('warn', `Could not switch back to the installer window: ${(err as Error)?.message ?? String(err)}`);
        }
      }
      return info.version;
    }
  }
  const minutes = Math.round((options.timeoutMs ?? DOCKER_READY_TIMEOUT_MS) / 60_000);
  throw new CommandError({
    message: `Docker did not become ready within ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    command: `${cli} info`,
    outputTail: info.output,
  });
}

/** Reads `docker container inspect` output for the dev container. Exported for tests. */
export function parseContainerState(result: { ok: true; stdout: string } | { ok: false; output: string }): DevContainerStatus {
  if (result.ok) {
    const running = result.stdout.trim();
    if (running === 'true') return 'running';
    if (running === 'false') return 'stopped';
    return 'unknown';
  }
  return /no such (container|object)/i.test(result.output) ? 'missing' : 'unknown';
}

/**
 * Whether the dev container exists and runs, for the system check. Never starts Docker; when the
 * daemon is down (or slow) the answer is `unknown`, which the install step then sorts out.
 */
export async function detectDevContainer(
  dockerKind: DockerKind,
  targetOS: TargetOS = getTargetOS(),
  timeoutMs = 5_000
): Promise<DevContainerStatus> {
  if (dockerKind === 'none') return 'missing';
  const cli = resolveDockerCli(targetOS);
  try {
    const res = await execCommand(cli, ['container', 'inspect', '--format', '{{.State.Running}}', DEV_CONTAINER_NAME], {
      env: dockerEnv(cli, process.env, targetOS),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return parseContainerState({ ok: true, stdout: res.stdout });
  } catch (err) {
    const output = err instanceof CommandError ? err.outputTail.join('\n') : String((err as Error)?.message ?? err);
    return parseContainerState({ ok: false, output });
  }
}

export { formatBytes, formatElapsed } from './format';

/** One line of `docker compose --progress json pull`. Layer lines carry `parent_id` (the image). */
export interface ComposeProgressEvent {
  id?: string;
  parent_id?: string;
  status?: string;
  text?: string;
  details?: string;
  current?: number;
  total?: number;
  percent?: number;
  /** Set on failure lines: `{"error":true,"message":"..."}`. */
  error?: boolean;
  message?: string;
}

export function parseComposeProgress(line: string): ComposeProgressEvent | null {
  if (!line.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as ComposeProgressEvent) : null;
  } catch {
    return null;
  }
}

export interface PullStatus {
  label: string;
  percent: number;
}

/** Share of the bar for downloading; unpacking fills the rest. */
const DOWNLOAD_BAND = 90;
/** Assumed speed for the estimate shown when Docker reports no byte counts. */
const ESTIMATE_BYTES_PER_SEC = 4e6;
/** Estimate time constant when not even the image size is known. */
const ESTIMATE_DEFAULT_TAU_MS = 180_000;

interface LayerState {
  current: number;
  size?: number;
  downloaded: boolean;
  extracted: boolean;
  /** Already on disk before this pull: left out of the totals. */
  preexisting: boolean;
}

/**
 * Turns `docker compose --progress json pull` events into one status for the progress bar.
 *
 * What Compose reports varies a lot: for some registries every layer reports its bytes, for others
 * (ghcr.io with the containerd image store) only "Pulling" and "Pulled" arrive, minutes apart. So:
 * - layer sizes come from the registry manifest when known (`setExpectedLayers`), else from events;
 * - bytes are counted from "Downloading" events and from finished layers;
 * - without any byte counts, `tick()` shows an estimate that slows down and stops below 90%
 *   (only with `estimate: true`; a source that reports bytes shows the time waited at 0% instead);
 * - downloading fills 0–90%, unpacking 90–100%, and the percentage never goes backwards.
 */
export class PullProgressTracker {
  /** Show a time-based estimate while no byte counts arrive. Off when the source reports bytes. */
  estimate: boolean;
  private readonly layers = new Map<string, LayerState>();
  private expected = new Map<string, number>();
  private image: { current: number; total: number } | null = null;
  /** True once Docker reported live byte counts; the estimate then stops. */
  private sawBytes = false;
  private extracting = false;
  private elapsedMs = 0;
  private maxPercent = 0;
  private last: PullStatus | null = null;
  private readonly counts = new Map<string, number>();

  constructor(options: { estimate?: boolean } = {}) {
    this.estimate = options.estimate ?? true;
  }

  /** Applies one event. Returns the status to show when it changed, else null. */
  update(event: ComposeProgressEvent): PullStatus | null {
    if (!event.id) return null;
    const text = (event.text ?? '').trim().toLowerCase();
    if (event.text) this.counts.set(event.text, (this.counts.get(event.text) ?? 0) + 1);
    if (!event.parent_id) return this.updateImage(event);
    if (this.expected.size > 0 && !this.expected.has(event.id)) return null;

    const layer = this.layer(event.id);
    if (text === 'already exists' || text === 'exists') {
      // A retry reports layers it finished earlier as existing: keep counting those.
      if (!layer.downloaded) layer.preexisting = true;
    } else if (text === 'downloading') {
      if (typeof event.total === 'number' && event.total > 0 && !this.expected.has(event.id)) layer.size = event.total;
      if (typeof event.current === 'number' && event.current > 0) {
        layer.current = layer.size ? Math.min(event.current, layer.size) : event.current;
        this.sawBytes = true;
      }
    } else if (text === 'verifying checksum' || text === 'download complete') {
      layer.downloaded = true;
    } else if (text === 'extracting') {
      layer.downloaded = true;
      this.extracting = true;
    } else if (text === 'pull complete') {
      layer.downloaded = true;
      layer.extracted = true;
    }
    // "Pulling fs layer", "Waiting": the layer is registered, nothing else to do.
    return this.publish(false);
  }

  /** Sets layer sizes (short id -> bytes) from the registry manifest, which fixes the total up front. */
  setExpectedLayers(sizes: Map<string, number>): PullStatus | null {
    if (sizes.size === 0) return null;
    this.expected = sizes;
    for (const [id, size] of sizes) {
      const layer = this.layers.get(id);
      if (layer) layer.size = size;
    }
    return this.publish(false);
  }

  /** Advances the time-based estimate. Call about once a second while the pull runs. */
  tick(elapsedMs: number): PullStatus | null {
    this.elapsedMs = Math.max(this.elapsedMs, elapsedMs);
    return this.publish(true);
  }

  get downloadedBytes(): number {
    return this.measure().done;
  }

  /** Event counts by text, for the log: "Pulling×1, Pulled×1". */
  summary(): string {
    return [...this.counts].map(([text, n]) => `${text}×${n}`).join(', ');
  }

  private layer(id: string): LayerState {
    let layer = this.layers.get(id);
    if (!layer) {
      layer = { current: 0, size: this.expected.get(id), downloaded: false, extracted: false, preexisting: false };
      this.layers.set(id, layer);
    }
    return layer;
  }

  private updateImage(event: ComposeProgressEvent): PullStatus | null {
    if (typeof event.total !== 'number' || event.total <= 0 || typeof event.current !== 'number') return null;
    this.image = { current: Math.min(Math.max(event.current, 0), event.total), total: event.total };
    if (event.current > 0) this.sawBytes = true;
    return this.publish(false);
  }

  /** The layers this pull fetches: the manifest's when known, else every layer seen so far. */
  private measure(): { done: number; total: number; layers: number; downloaded: number; extracted: number } {
    const fetch: LayerState[] = [];
    if (this.expected.size > 0) {
      for (const [id, size] of this.expected) {
        const layer = this.layers.get(id) ?? { current: 0, size, downloaded: false, extracted: false, preexisting: false };
        if (!layer.preexisting) fetch.push(layer);
      }
    } else {
      for (const layer of this.layers.values()) if (!layer.preexisting) fetch.push(layer);
    }
    let done = 0;
    let total = 0;
    let downloaded = 0;
    let extracted = 0;
    for (const l of fetch) {
      if (l.downloaded) downloaded++;
      if (l.extracted) extracted++;
      if (!l.size) continue;
      total += l.size;
      done += l.downloaded ? l.size : Math.min(l.current, l.size);
    }
    if (fetch.length === 0 && this.image) return { done: this.image.current, total: this.image.total, layers: 0, downloaded: 0, extracted: 0 };
    return { done, total, layers: fetch.length, downloaded, extracted };
  }

  private estimatePercent(totalBytes: number): number {
    if (!this.estimate || this.sawBytes || this.elapsedMs <= 0) return 0;
    const tau = totalBytes > 0 ? (totalBytes / ESTIMATE_BYTES_PER_SEC) * 1000 : ESTIMATE_DEFAULT_TAU_MS;
    return DOWNLOAD_BAND * (1 - Math.exp(-this.elapsedMs / tau));
  }

  private compute(): PullStatus | null {
    const m = this.measure();
    const allDownloaded = m.layers > 0 ? m.downloaded >= m.layers : m.total > 0 && m.done >= m.total;
    if (allDownloaded && (this.extracting || m.extracted > 0)) {
      const share = m.layers > 0 ? m.extracted / m.layers : 0;
      return { label: 'Unpacking the dev container...', percent: DOWNLOAD_BAND + (100 - DOWNLOAD_BAND) * share };
    }
    const real = m.total > 0 ? (m.done / m.total) * DOWNLOAD_BAND : 0;
    const percent = Math.max(real, this.estimatePercent(m.total));
    if (m.done > 0) return { label: `Downloading the dev container: ${formatBytes(m.done)} of ${formatBytes(m.total)}`, percent };
    if (m.total === 0 && m.downloaded > 0) {
      return { label: `Downloading the dev container: ${m.downloaded} of ${m.layers} layers`, percent };
    }
    if (this.sawBytes || this.elapsedMs <= 0) return null;
    if (!this.estimate) return { label: `Preparing the dev container... ${formatElapsed(this.elapsedMs)}`, percent: 0 };
    const size = m.total > 0 ? ` (${formatBytes(m.total)})` : '';
    return { label: `Downloading the dev container${size}... ${formatElapsed(this.elapsedMs)}`, percent };
  }

  private publish(fromTick: boolean): PullStatus | null {
    const next = this.compute();
    if (!next) return null;
    this.maxPercent = Math.min(100, Math.max(this.maxPercent, Math.floor(next.percent)));
    const status = { label: next.label, percent: this.maxPercent };
    // A tick with nothing new is not worth an event.
    if (fromTick && this.last && this.last.label === status.label && this.last.percent === status.percent) return null;
    this.last = status;
    return status;
  }
}

/**
 * Sends at most one value per `intervalMs`, but always the latest one: a value that arrives too soon
 * is held and sent when the interval ends. A change of phase goes out at once.
 */
export function createThrottle<T>(send: (value: T) => void, intervalMs: number, phaseOf: (value: T) => string) {
  let lastSent = 0;
  let lastPhase: string | undefined;
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const sendNow = (value: T) => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
    lastSent = Date.now();
    lastPhase = phaseOf(value);
    send(value);
  };

  return {
    push(value: T): void {
      const elapsed = Date.now() - lastSent;
      if (phaseOf(value) !== lastPhase || elapsed >= intervalMs) return sendNow(value);
      pending = { value };
      timer ??= setTimeout(() => pending && sendNow(pending.value), intervalMs - elapsed);
    },
    /** Sends the held value, if any. Call when done. */
    flush(): void {
      if (pending) sendNow(pending.value);
    },
  };
}

/** Parses `docker manifest inspect --verbose` output into layer sizes by short id (12 hex digits). */
export function parseManifestLayers(raw: unknown, platform: { os: string; architecture: string }): Map<string, number> | null {
  const entries = (Array.isArray(raw) ? raw : [raw]).filter((e): e is Record<string, any> => Boolean(e) && typeof e === 'object');
  const entry =
    entries.length === 1
      ? entries[0]
      : entries.find((e) => e.Descriptor?.platform?.os === platform.os && e.Descriptor?.platform?.architecture === platform.architecture);
  const layers: unknown = (entry?.OCIManifest ?? entry?.SchemaV2Manifest)?.layers;
  if (!Array.isArray(layers)) return null;
  const sizes = new Map<string, number>();
  for (const layer of layers) {
    const hex = typeof layer?.digest === 'string' ? layer.digest.split(':')[1] : undefined;
    if (hex && typeof layer.size === 'number' && layer.size > 0) sizes.set(hex.slice(0, 12), layer.size);
  }
  return sizes.size > 0 ? sizes : null;
}

/** "linux/amd64" -> { os, architecture }; defaults to Linux on this machine's architecture. */
export function parsePlatform(value: string | undefined, arch: string = process.arch): { os: string; architecture: string } {
  const [os, architecture] = (value ?? '').split('/');
  if (os && architecture) return { os, architecture };
  return { os: 'linux', architecture: arch === 'x64' ? 'amd64' : arch };
}

const REGISTRY_CHECK_TIMEOUT_MS = 20_000;

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

export interface ComposeImage {
  image: string;
  platform?: string;
}

/** The images in the compose file, with the platform each one asks for. */
export async function listComposeImages(cli: string, composePath: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<ComposeImage[]> {
  const res = await execCommand(cli, buildComposeArgs(composePath, 'config', '--format', 'json'), {
    env,
    signal: withTimeout(signal, REGISTRY_CHECK_TIMEOUT_MS),
  });
  const services = Object.values((JSON.parse(res.stdout)?.services ?? {}) as Record<string, { image?: unknown; platform?: unknown }>);
  return services
    .filter((s): s is { image: string; platform?: unknown } => typeof s.image === 'string' && s.image.length > 0)
    .map((s) => ({ image: s.image, platform: typeof s.platform === 'string' ? s.platform : undefined }));
}

/** Registry answers that mean "you may not have this image": retrying or downloading won't help. */
export const REGISTRY_REFUSED = /\bunauthorized\b|\bdenied\b|manifest unknown|no such manifest/i;

export type RegistryAccess =
  | { kind: 'ok'; sizes: Map<string, number> | null }
  | { kind: 'refused'; image: string; output: string[] }
  | { kind: 'unknown'; reason: string };

/**
 * Asks the registry for each image's manifest (nothing is downloaded): whether this computer may
 * pull it, and its layer sizes. `unknown` when the registry or CLI can't tell (old CLI, timeout).
 */
export async function checkRegistryAccess(
  cli: string,
  images: ComposeImage[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<RegistryAccess> {
  const sizes = new Map<string, number>();
  let sizesKnown = true;
  for (const { image, platform } of images) {
    let stdout: string;
    try {
      stdout = (await execCommand(cli, ['manifest', 'inspect', '--verbose', image], { env, signal: withTimeout(signal, REGISTRY_CHECK_TIMEOUT_MS) }))
        .stdout;
    } catch (err) {
      if (signal?.aborted) throw new Error('Cancelled');
      const output = err instanceof CommandError ? err.outputTail : [(err as Error)?.message ?? String(err)];
      if (REGISTRY_REFUSED.test(output.join('\n'))) return { kind: 'refused', image, output };
      return { kind: 'unknown', reason: output.at(-1) ?? 'no output' };
    }
    try {
      const layers = parseManifestLayers(JSON.parse(stdout), parsePlatform(platform));
      if (layers) for (const [id, size] of layers) sizes.set(id, size);
      else sizesKnown = false;
    } catch {
      sizesKnown = false;
    }
  }
  return { kind: 'ok', sizes: sizesKnown && sizes.size > 0 ? sizes : null };
}

/** Older Docker Compose versions have no `--progress json`. */
export const NO_JSON_PROGRESS = /unknown flag: --progress|invalid progress|unsupported (--)?progress/i;
/** Network trouble or a busy registry: worth another try (Docker resumes the layers it has). */
export function isTransientPullError(output: string): boolean {
  return isRetryableText(output);
}

const PULL_RETRY_DELAYS_MS = [3_000, 10_000];

/** The registry host of an image reference, or null for Docker Hub. */
export function registryOf(image: string): string | null {
  const first = image.split('/')[0];
  return image.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost') ? first : null;
}

export interface PullOptions {
  retryDelaysMs?: number[];
  /** The bundled ghcr.io login, if any; otherwise the docker CLI's own saved login is used. */
  credentials?: RegistryCredentials | null;
  watchdog?: WatchdogLimits;
  /** Replaces the daemon socket request (tests). */
  open?: OpenPullStream;
  /** Replaces the socket lookup (tests); null forces the compose path. */
  socketPath?: string | null;
  /** Replaces the connectivity check and the wait for the connection (tests). */
  network?: Pick<RetryOptions, 'isOnline' | 'maxWaitMs' | 'pollMs'>;
}

/** Retry settings shared by the engine and compose pulls. */
function pullRetry(emit: Emit, signal: AbortSignal | undefined, retryDelaysMs: number[], options: PullOptions): RetryOptions {
  return {
    signal,
    ...options.network,
    maxAttempts: retryDelaysMs.length + 1,
    backoffMs: retryDelaysMs,
    onEvent: networkReporter(emit, 'Containers', 'downloading the dev container'),
  };
}

type Emit = (event: InstallEvent) => void;

/**
 * Pulls the compose images with progress on the Containers bar.
 *
 * 1. Checks registry access first, so a missing or refused login fails in seconds, not after a
 *    download that never starts.
 * 2. Pulls through the Docker Engine API, which reports bytes; a watchdog gives up on a pull that
 *    stops moving (Docker can hang before the first byte) and retries it.
 * 3. Falls back to `docker compose pull` when the daemon socket can't be reached directly.
 */
export async function pullImages(
  cli: string,
  composePath: string,
  exec: { env: NodeJS.ProcessEnv; signal?: AbortSignal },
  emit: Emit,
  options: PullOptions = {}
): Promise<void> {
  const { signal } = exec;
  const retryDelaysMs = options.retryDelaysMs ?? PULL_RETRY_DELAYS_MS;
  const warn = (message: string) => emit(logEvent(message, 'warn'));
  const tracker = new PullProgressTracker();
  const throttle = createThrottle<PullStatus>(
    (s) => emit({ type: 'progress', step: 'Containers', label: s.label, percent: s.percent }),
    250,
    (s) => (s.label.startsWith('Unpacking') ? 'unpack' : 'download')
  );
  const show = (status: PullStatus | null) => {
    if (status) throttle.push(status);
  };

  emit({ type: 'progress', step: 'Containers', label: 'Checking access to the container registry...', percent: 0 });
  let images: ComposeImage[] = [];
  try {
    images = await listComposeImages(cli, composePath, exec.env, signal);
  } catch (err) {
    if (signal?.aborted) throw new Error('Cancelled');
    warn(`Could not read the image list from the container definition: ${(err as Error)?.message ?? String(err)}`);
  }

  if (images.length > 0) {
    const access = await checkRegistryAccess(cli, images, exec.env, signal);
    if (access.kind === 'refused') {
      const reason = access.output.at(-1)?.trim() || 'access denied';
      throw new CommandError({
        message: `The registry refused access to ${access.image}: ${reason}`,
        command: `${cli} manifest inspect ${access.image}`,
        outputTail: access.output,
        details: options.credentials
          ? []
          : [`No registry credentials are bundled, and this computer is not signed in to ${registryOf(access.image) ?? 'the registry'}.`],
      });
    }
    if (access.kind === 'unknown') {
      warn(`Could not check the registry (${access.reason}); trying the download anyway.`);
    } else if (access.sizes) {
      let total = 0;
      for (const size of access.sizes.values()) total += size;
      emit(logEvent(`The dev container is ${formatBytes(total)} in ${access.sizes.size} layers.`));
      show(tracker.setExpectedLayers(access.sizes));
    } else {
      warn('The registry did not report the image size.');
    }
  }

  const socketPath =
    options.socketPath !== undefined ? options.socketPath : images.length > 0 ? await resolveDockerSocket(cli, exec.env, signal) : null;
  // The Engine API reports bytes, so no time-based guess is needed there.
  tracker.estimate = !socketPath;
  emit({ type: 'progress', step: 'Containers', label: 'Preparing the dev container...', percent: 0 });
  const started = Date.now();
  const heartbeat = setInterval(() => show(tracker.tick(Date.now() - started)), 1_000);

  try {
    let pulled = false;
    if (socketPath) {
      try {
        await pullWithEngine(socketPath, images, exec, emit, tracker, show, retryDelaysMs, options);
        pulled = true;
      } catch (err) {
        if (!(err instanceof EngineUnavailableError)) throw err;
        warn(`${err.message}. Pulling with docker compose instead (progress is an estimate).`);
        tracker.estimate = true;
      }
    }
    if (!pulled) await pullWithCompose(cli, composePath, exec, emit, tracker, show, retryDelaysMs, options);
  } finally {
    clearInterval(heartbeat);
    throttle.flush();
    const events = tracker.summary();
    if (events) emit(logEvent(`Pull events: ${events}`));
  }
  if (tracker.downloadedBytes > 0) emit(logEvent(`Downloaded ${formatBytes(tracker.downloadedBytes)}.`));
}

async function pullWithEngine(
  socketPath: string,
  images: ComposeImage[],
  exec: { env: NodeJS.ProcessEnv; signal?: AbortSignal },
  emit: Emit,
  tracker: PullProgressTracker,
  show: (status: PullStatus | null) => void,
  retryDelaysMs: number[],
  options: PullOptions
): Promise<void> {
  const { signal } = exec;
  const auths = new Map<string, string | undefined>();
  const authFor = async (image: string): Promise<string | undefined> => {
    const registry = registryOf(image);
    if (!registry) return undefined;
    if (!auths.has(registry)) {
      const login =
        registry === REGISTRY && options.credentials
          ? { username: options.credentials.username, password: options.credentials.token }
          : await readDockerLogin(registry, { env: exec.env, signal });
      if (!login) emit(logEvent(`No saved login for ${registry}; pulling without credentials.`, 'warn'));
      auths.set(registry, login ? encodeRegistryAuth(login, registry) : undefined);
    }
    return auths.get(registry);
  };

  for (const { image, platform } of images) {
    const auth = await authFor(image);
    await withNetworkRetry(
      () =>
        pullImageViaEngine({
          socketPath,
          image,
          platform,
          auth,
          signal,
          limits: options.watchdog,
          open: options.open,
          onQuiet: (limitMs) =>
            emit(
              logEvent(
                `Docker reports no progress while it resolves the image or unpacks layers it already downloaded; waiting up to ${Math.round(limitMs / 60_000)} minutes.`
              )
            ),
          onMessage: (msg) => {
            const failure = engineError(msg);
            if (failure) return emit(logEvent(failure, 'error', true));
            if (msg.id && isLayerId(msg.id)) {
              const { current, total } = msg.progressDetail ?? {};
              show(tracker.update({ id: msg.id, parent_id: image, text: msg.status, current, total }));
            } else if (msg.status) {
              // "latest: Pulling from ...", "Digest: ...", "Status: Image is up to date ..."
              emit(logEvent(msg.id ? `${msg.id}: ${msg.status}` : msg.status, 'info', true));
            }
          },
        }),
      {
        ...pullRetry(emit, signal, retryDelaysMs, options),
        // An unreachable socket means "use compose", not "retry". A stall decides for itself (see PullStalledError).
        isRetryable: (err) => !(err instanceof EngineUnavailableError) && isRetryableError(err),
      }
    );
  }
}

async function pullWithCompose(
  cli: string,
  composePath: string,
  exec: { env: NodeJS.ProcessEnv; signal?: AbortSignal },
  emit: Emit,
  tracker: PullProgressTracker,
  show: (status: PullStatus | null) => void,
  retryDelaysMs: number[],
  options: PullOptions
): Promise<void> {
  const output = (line: string) => emit(logEvent(line, 'info', true));
  const onOutput = (line: string) => {
    const event = parseComposeProgress(line);
    if (!event) return output(line);
    if (!event.parent_id) {
      // Image-level lines ("Pulling", "Pulled", errors) are worth keeping in the log.
      const text = [event.id, event.text, event.details, event.message].filter(Boolean).join(' ');
      if (text) emit(logEvent(text, event.error ? 'error' : 'info', true));
    }
    show(tracker.update(event));
  };

  let jsonProgress = true;
  await withNetworkRetry(async () => {
    if (!jsonProgress) {
      await execCommand(cli, buildComposeArgs(composePath, 'pull'), { ...exec, onOutput: output });
      return;
    }
    try {
      await execCommand(cli, buildComposeArgs(composePath, '--progress', 'json', 'pull'), { ...exec, onOutput });
    } catch (err) {
      if (exec.signal?.aborted || !(err instanceof CommandError) || !NO_JSON_PROGRESS.test(err.outputTail.join('\n'))) throw err;
      emit(logEvent('This Docker Compose cannot report download progress; pulling without it.', 'warn'));
      jsonProgress = false;
      await execCommand(cli, buildComposeArgs(composePath, 'pull'), { ...exec, onOutput: output });
    }
  }, pullRetry(emit, exec.signal, retryDelaysMs, options));
}

/** Whether every image is already on this computer. */
export async function imagesPresent(cli: string, env: NodeJS.ProcessEnv, images: ComposeImage[], signal?: AbortSignal): Promise<boolean> {
  if (images.length === 0) return false;
  for (const { image } of images) {
    try {
      await execCommand(cli, ['image', 'inspect', '--format', '{{.Id}}', image], { env, signal });
    } catch {
      if (signal?.aborted) throw new Error('Cancelled');
      return false;
    }
  }
  return true;
}

/**
 * Downloads the dev container, unless there is no internet and it is already on this computer:
 * then the one we have is used, so a re-run works offline. A download that fails for lack of
 * network (after waiting for it) also falls back to the local copy. Otherwise errors pass through.
 */
export async function pullOrUseLocal(steps: {
  pull: () => Promise<void>;
  isOnline: () => Promise<boolean>;
  haveLocal: () => Promise<boolean>;
  warn: (message: string) => void;
  signal?: AbortSignal;
}): Promise<'pulled' | 'local'> {
  const useLocal = (why: string): 'local' => {
    steps.warn(`${why} Using the dev container already on this computer (it may not be the newest).`);
    return 'local';
  };
  if (!(await steps.isOnline()) && (await steps.haveLocal())) return useLocal('No internet connection.');
  try {
    await steps.pull();
    return 'pulled';
  } catch (err) {
    if (steps.signal?.aborted) throw err;
    const networkTrouble = err instanceof OfflineError || err instanceof PullStalledError || isRetryableError(err);
    if (networkTrouble && (await steps.haveLocal())) {
      return useLocal(`Could not download the newest dev container (${errorText(err).split('\n')[0]}).`);
    }
    throw err;
  }
}

/**
 * Pulls the bundled compose file's images from ghcr.io and starts them. Logs in with the bundled
 * registry credentials when there are any; otherwise relies on an existing `docker login`.
 */
export async function startContainers(options: {
  composePath: string;
  credentialFiles: string[];
  dryRun?: boolean;
  signal?: AbortSignal;
  emit: (event: InstallEvent) => void;
  /** Called once Docker Desktop, launched by the installer, is ready and its window hidden. */
  onDockerStarted?: () => void | Promise<void>;
}): Promise<string> {
  const { composePath, signal, emit } = options;
  const targetOS = getTargetOS();
  const log = (level: 'info' | 'warn', message: string, output = false) => emit(logEvent(message, level, output));
  const progress = (label: string) => emit({ type: 'progress', step: 'Containers', label });

  if (!fs.existsSync(composePath)) throw new Error(`Container definition not found: ${composePath}`);
  if (options.dryRun) {
    log('info', `[dry-run] Would pull and start the containers in ${composePath}`);
    return 'would start';
  }

  const kind = await detectDocker(targetOS);
  const cli = resolveDockerCli(targetOS);
  const env = dockerEnv(cli, process.env, targetOS);
  log('info', `Using docker CLI: ${cli}`);

  progress('Checking Docker...');
  const version = await waitForDocker({
    cli,
    env,
    targetOS,
    kind,
    emit,
    signal,
    // Docker Desktop came to the front while starting; hide it and hand focus back to the installer.
    onStarted: async () => {
      await dismissDockerDesktop(targetOS, log);
      await options.onDockerStarted?.();
    },
  });
  log('info', `Docker ${version} is running.`);

  const onOutput = (line: string) => log('info', line, true);
  const creds = loadRegistryCredentials(options.credentialFiles);
  const images = await listComposeImages(cli, composePath, env, signal).catch((): ComposeImage[] => []);
  await pullOrUseLocal({
    signal,
    warn: (message) => log('warn', message),
    isOnline: async () => (await checkConnectivity({ signal })).online,
    haveLocal: () => imagesPresent(cli, env, images, signal),
    pull: async () => {
      if (creds) {
        progress('Signing in to the container registry...');
        log('info', `Signing in to ${REGISTRY} as ${creds.username}...`);
        // The token goes over stdin, never on the command line (which ends up in logs and reports).
        await withNetworkRetry(
          () => execCommand(cli, ['login', REGISTRY, '--username', creds.username, '--password-stdin'], { env, signal, onOutput, input: `${creds.token}\n` }),
          { signal, onEvent: networkReporter(emit, 'Containers', 'signing in to the container registry') }
        );
      } else {
        log('warn', `No registry credentials are bundled; using this computer's existing Docker login for ${REGISTRY}.`);
      }
      await pullImages(cli, composePath, { env, signal }, emit, { credentials: creds });
    },
  });

  progress('Starting the dev container...');
  await execCommand(cli, buildComposeArgs(composePath, 'up', '-d'), { env, signal, onOutput });

  if (targetOS === 'linux' && kind === 'engine') {
    emit({
      type: 'note',
      message:
        "The dev container reaches Ollama through host.docker.internal. With Docker Engine, Ollama must listen on all interfaces: set OLLAMA_HOST=0.0.0.0 for the Ollama service (sudo systemctl edit ollama), then restart it.",
    });
  }
  return 'running';
}
