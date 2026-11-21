import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { detectDocker } from './docker';
import { CommandError } from './errors';
import { logEvent } from './events';
import { execCommand } from './exec';
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
      await execCommand('open', ['-g', '-a', 'Docker'], { signal });
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
    if (info.ok) return info.version;
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

/** Bytes as progress text, in the decimal units Docker uses: "850 KB", "312 MB", "1.21 GB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e7) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

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

/**
 * Adds up per-layer download progress into one "X MB of Y MB" status. A layer's size is only known
 * once it starts downloading (Docker fetches a few at a time), so the total can grow during the
 * pull; the percentage never goes backwards so the bar doesn't jump.
 */
export class PullProgressTracker {
  private readonly layers = new Map<string, { current: number; total: number }>();
  private extracting = false;
  private maxPercent = 0;

  /** Applies one event. Returns the status to show when it changed anything, else null. */
  update(event: ComposeProgressEvent): { label: string; percent: number } | null {
    if (!event.id || !event.parent_id) return null;
    const layer = this.layers.get(event.id);
    if (event.text === 'Downloading' && typeof event.total === 'number' && event.total > 0) {
      this.layers.set(event.id, { current: Math.min(Math.max(event.current ?? 0, 0), event.total), total: event.total });
    } else if ((event.text === 'Download complete' || event.text === 'Pull complete') && layer) {
      layer.current = layer.total;
    } else if (event.text === 'Extracting') {
      this.extracting = true;
    } else {
      return null;
    }
    return this.status();
  }

  get downloadedBytes(): number {
    let sum = 0;
    for (const l of this.layers.values()) sum += l.current;
    return sum;
  }

  private status(): { label: string; percent: number } | null {
    let total = 0;
    for (const l of this.layers.values()) total += l.total;
    if (total === 0) return null;
    const done = this.downloadedBytes;
    this.maxPercent = Math.max(this.maxPercent, Math.floor((done / total) * 100));
    if (done >= total && this.extracting) return { label: 'Unpacking the dev container...', percent: 100 };
    return { label: `Downloading the dev container: ${formatBytes(done)} of ${formatBytes(total)}`, percent: this.maxPercent };
  }
}

/** Older Docker Compose versions have no `--progress json`. */
const NO_JSON_PROGRESS = /unknown flag: --progress|invalid progress|unsupported progress/i;

/** Pulls the compose images, reporting downloaded bytes as progress. Falls back to plain output on old Compose. */
async function pullImages(
  cli: string,
  composePath: string,
  exec: { env: NodeJS.ProcessEnv; signal?: AbortSignal },
  emit: (event: InstallEvent) => void
): Promise<void> {
  const progress = (label: string, percent?: number) => emit({ type: 'progress', step: 'Containers', label, percent });
  const output = (line: string) => emit(logEvent(line, 'info', true));
  const tracker = new PullProgressTracker();
  let lastEmit = 0;
  let lastLabel = '';

  const onOutput = (line: string) => {
    const event = parseComposeProgress(line);
    if (!event) return output(line);
    if (!event.parent_id) {
      // Image-level lines ("Pulling", "Pulled", errors) are worth keeping in the log.
      return output([event.id, event.text, event.details].filter(Boolean).join(' '));
    }
    const status = tracker.update(event);
    if (!status) return;
    // At most a few updates a second, but never drop a change of phase (download -> unpack).
    const now = Date.now();
    const phase = status.label.split(':')[0];
    if (now - lastEmit < 250 && phase === lastLabel) return;
    lastEmit = now;
    lastLabel = phase;
    progress(status.label, status.percent);
  };

  progress('Downloading the dev container...', 0);
  try {
    await execCommand(cli, buildComposeArgs(composePath, '--progress', 'json', 'pull'), { ...exec, onOutput });
  } catch (err) {
    if (!(err instanceof CommandError) || !NO_JSON_PROGRESS.test(err.outputTail.join('\n'))) throw err;
    emit(logEvent('This Docker Compose cannot report download progress; pulling without it.', 'warn'));
    await execCommand(cli, buildComposeArgs(composePath, 'pull'), { ...exec, onOutput: output });
    return;
  }
  if (tracker.downloadedBytes > 0) emit(logEvent(`Downloaded ${formatBytes(tracker.downloadedBytes)}.`));
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
  const version = await waitForDocker({ cli, env, targetOS, kind, emit, signal });
  log('info', `Docker ${version} is running.`);

  const onOutput = (line: string) => log('info', line, true);
  const creds = loadRegistryCredentials(options.credentialFiles);
  if (creds) {
    progress('Signing in to the container registry...');
    log('info', `Signing in to ${REGISTRY} as ${creds.username}...`);
    // The token goes over stdin, never on the command line (which ends up in logs and reports).
    await execCommand(cli, ['login', REGISTRY, '--username', creds.username, '--password-stdin'], {
      env,
      signal,
      onOutput,
      input: `${creds.token}\n`,
    });
  } else {
    log('warn', `No registry credentials are bundled; using this computer's existing Docker login for ${REGISTRY}.`);
  }

  await pullImages(cli, composePath, { env, signal }, emit);

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
