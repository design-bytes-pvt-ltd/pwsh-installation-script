import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { CommandError } from './errors';
import { execCommand } from './exec';

/**
 * Pulls images straight from the Docker Engine API (`POST /images/create`) over the daemon socket.
 *
 * `docker compose pull` hides the per-layer byte counts for some registries (ghcr.io with the
 * containerd image store reports only "Pulling" ... "Pulled"), so a pull that hangs before the first
 * byte looks the same as a slow one. The Engine API stream carries the byte counts, which lets a
 * watchdog tell the two apart and give up on a pull that has stopped moving.
 */

/** One line of the Engine API pull stream. */
export interface EngineMessage {
  status?: string;
  id?: string;
  progressDetail?: { current?: number; total?: number };
  /** Newer daemons report failures as a bare `{"message": "..."}` line. */
  message?: string;
  error?: string;
  errorDetail?: { message?: string };
}

/** The daemon socket (or Windows named pipe) behind a docker host URL; null for tcp/ssh hosts. */
export function parseDockerHost(host: string): string | null {
  const value = host.trim();
  if (value.startsWith('unix://')) return value.slice('unix://'.length) || null;
  if (value.startsWith('npipe://')) {
    // npipe:////./pipe/docker_engine -> \\.\pipe\docker_engine
    const pipe = value.slice('npipe://'.length).replace(/\//g, '\\');
    return pipe.startsWith('\\\\') ? pipe : null;
  }
  return null;
}

/** The daemon socket of the current docker context (honors DOCKER_HOST / DOCKER_CONTEXT), or null. */
export async function resolveDockerSocket(cli: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await execCommand(cli, ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
      env,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    return parseDockerHost(res.stdout);
  } catch {
    if (signal?.aborted) throw new Error('Cancelled');
    return null;
  }
}

export interface RegistryAuth {
  username: string;
  password: string;
}

/**
 * The X-Registry-Auth header: base64url JSON *with* padding. The daemon decodes it with Go's
 * padded URL encoding, and an unpadded header is silently treated as no credentials (unauthorized).
 */
export function encodeRegistryAuth(auth: RegistryAuth, registry: string): string {
  const json = JSON.stringify({ username: auth.username, password: auth.password, serveraddress: registry });
  return Buffer.from(json, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

type Exec = typeof execCommand;

/**
 * Credentials for `registry` from the docker CLI's own store, the way `docker login` saved them:
 * a credential helper (credHelpers / credsStore) first, then a plain `auths` entry. Null when none.
 */
export async function readDockerLogin(
  registry: string,
  options: { env: NodeJS.ProcessEnv; configDir?: string; exec?: Exec; signal?: AbortSignal }
): Promise<RegistryAuth | null> {
  const configDir = options.configDir ?? options.env.DOCKER_CONFIG ?? path.join(options.env.HOME || os.homedir(), '.docker');
  let config: Record<string, any>;
  try {
    config = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
  const keys = [registry, `https://${registry}`];
  const helper: unknown = config.credHelpers?.[registry] ?? config.credsStore;
  if (typeof helper === 'string' && /^[\w.-]+$/.test(helper)) {
    const exec = options.exec ?? execCommand;
    for (const key of keys) {
      try {
        const res = await exec(`docker-credential-${helper}`, ['get'], {
          env: options.env,
          input: key,
          signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
        });
        const { Username, Secret } = JSON.parse(res.stdout) as { Username?: unknown; Secret?: unknown };
        if (typeof Username === 'string' && typeof Secret === 'string' && Username && Secret && Username !== '<token>') {
          return { username: Username, password: Secret };
        }
      } catch {
        if (options.signal?.aborted) throw new Error('Cancelled');
        // Not stored under this key (or the helper failed): try the next one.
      }
    }
  }
  for (const key of keys) {
    const encoded: unknown = config.auths?.[key]?.auth;
    if (typeof encoded !== 'string') continue;
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep > 0 && sep < decoded.length - 1) return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
  }
  return null;
}

/** "ghcr.io/org/img:tag" -> { repo, tag }; digests ("repo@sha256:...") go in tag, as the docker CLI does. */
export function splitImageRef(image: string): { repo: string; tag: string } {
  const at = image.indexOf('@');
  if (at >= 0) return { repo: image.slice(0, at), tag: image.slice(at + 1) };
  const colon = image.lastIndexOf(':');
  // A colon before the last "/" is a registry port, not a tag.
  if (colon > image.lastIndexOf('/')) return { repo: image.slice(0, colon), tag: image.slice(colon + 1) };
  return { repo: image, tag: 'latest' };
}

/** The daemon could not be reached over its socket; the caller can fall back to the docker CLI. */
export class EngineUnavailableError extends Error {
  constructor(readonly cause: Error) {
    super(`Could not reach the Docker API: ${cause.message}`);
    this.name = 'EngineUnavailableError';
  }
}

export type StallPhase = 'start' | 'download' | 'extract';

/** No progress for too long. Retrying may help; the report gets the `pull-stalled` hint. */
export class PullStalledError extends CommandError {
  readonly phase: StallPhase;
  /**
   * Only a stall while bytes were flowing is worth a retry (finished layers are kept). A silent
   * stall is not: retrying restarts any unpacking from scratch, which only makes it worse.
   */
  readonly networkRetryable: boolean;

  constructor(phase: StallPhase, image: string, idleMs: number) {
    super({ message: stallMessage(phase, image, idleMs), command: `docker pull ${image}` });
    this.name = 'PullStalledError';
    this.phase = phase;
    this.networkRetryable = phase === 'download';
  }
}

function stallMessage(phase: StallPhase, image: string, idleMs: number): string {
  const registry = image.split('/')[0];
  const idle = formatDuration(idleMs);
  // Before the first layer line Docker may be logging in, or unpacking layers it already has: it can't say which.
  if (phase === 'start') return `The dev container download made no progress: Docker reported nothing for ${idle}.`;
  if (phase === 'download') return `The dev container download stalled: no data from ${registry} for ${idle}.`;
  return `Unpacking the dev container stalled: no progress for ${idle}.`;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} seconds`;
  const m = Math.round(s / 60);
  return `${m} minutes`;
}

export interface WatchdogLimits {
  /**
   * Until the first layer line. Docker is silent here while it logs in and resolves the image, and
   * also while it unpacks layers it downloaded earlier (15 GB took 70 s on an M-series Mac), so this
   * must be as patient as `extractMs`: silence here does not mean a hang.
   */
  startMs: number;
  /** Bytes not moving while layers download. */
  downloadMs: number;
  /** While layers unpack, which reports little for big layers. */
  extractMs: number;
}

export const DEFAULT_WATCHDOG: WatchdogLimits = { startMs: 600_000, downloadMs: 120_000, extractMs: 600_000 };

const LAYER_ID = /^[0-9a-f]{12}$/;

/** Layer lines carry the short (12 hex digit) digest as their id; image lines carry the tag or nothing. */
export function isLayerId(id: string): boolean {
  return LAYER_ID.test(id);
}

/**
 * Tracks whether a pull is still moving. The daemon repeats "Downloading" lines with unchanged byte
 * counts, so only a new layer state or more bytes count as progress, never a line by itself.
 */
export class PullWatchdog {
  private readonly layers = new Map<string, { status: string; current: number }>();
  private lastProgress: number;
  private sawLayer = false;

  constructor(
    private readonly limits: WatchdogLimits,
    now: number
  ) {
    this.lastProgress = now;
  }

  observe(msg: EngineMessage, now: number): void {
    const id = msg.id ?? '';
    const status = (msg.status ?? '').trim();
    if (!LAYER_ID.test(id) || !status) {
      // "Digest: ..." and "Status: ..." mean the pull is wrapping up.
      if (/^(digest|status):/i.test(status)) this.lastProgress = now;
      return;
    }
    this.sawLayer = true;
    const current = msg.progressDetail?.current ?? 0;
    const prev = this.layers.get(id);
    if (!prev || prev.status !== status || current > prev.current) this.lastProgress = now;
    this.layers.set(id, { status, current: Math.max(current, prev?.current ?? 0) });
  }

  /** The phase that ran out of time, or null while the pull is still moving. */
  check(now: number): { phase: StallPhase; idleMs: number } | null {
    const phase = this.phase();
    const limit = phase === 'start' ? this.limits.startMs : phase === 'download' ? this.limits.downloadMs : this.limits.extractMs;
    const idleMs = now - this.lastProgress;
    return idleMs >= limit ? { phase, idleMs } : null;
  }

  phase(): StallPhase {
    if (!this.sawLayer) return 'start';
    for (const l of this.layers.values()) if (/^extracting$/i.test(l.status)) return 'extract';
    return 'download';
  }
}

export interface PullRequest {
  socketPath: string;
  path: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}

/** Opens the pull stream. Rejects with EngineUnavailableError when the socket can't be reached. */
export type OpenPullStream = (req: PullRequest) => Promise<Readable>;

export const openPullStream: OpenPullStream = (req) =>
  new Promise((resolve, reject) => {
    const httpReq = http.request(
      { socketPath: req.socketPath, path: req.path, method: 'POST', headers: { Host: 'docker', ...req.headers }, signal: req.signal },
      (res) => {
        if ((res.statusCode ?? 500) < 400) return resolve(res);
        // Errors before the stream starts (404 pull access denied, 500) come as one JSON body.
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('error', reject);
        res.on('end', () => {
          let message = body.trim();
          try {
            message = (JSON.parse(body) as { message?: string }).message ?? message;
          } catch {
            // Not JSON: keep the raw body.
          }
          reject(new CommandError({ message: message || `HTTP ${res.statusCode}`, command: `POST ${req.path}` }));
        });
      }
    );
    httpReq.on('error', (err: NodeJS.ErrnoException) => {
      if (req.signal.aborted) return reject(err);
      reject(new EngineUnavailableError(err));
    });
    httpReq.end();
  });

export interface EnginePullOptions {
  socketPath: string;
  image: string;
  platform?: string;
  /** Encoded X-Registry-Auth header, if any. */
  auth?: string;
  signal?: AbortSignal;
  onMessage: (msg: EngineMessage) => void;
  limits?: WatchdogLimits;
  open?: OpenPullStream;
  /** How often the watchdog looks. */
  checkEveryMs?: number;
  /** Called once if Docker stays silent this long before the first layer line (default 30 s). */
  onQuiet?: (limitMs: number) => void;
  quietAfterMs?: number;
}

/** The error text of a stream line, if it reports a failure. */
export function engineError(msg: EngineMessage): string | null {
  if (msg.errorDetail?.message) return msg.errorDetail.message;
  if (msg.error) return msg.error;
  if (msg.message && !msg.status) return msg.message;
  return null;
}

/** Pulls one image, failing with PullStalledError when the watchdog sees no progress for too long. */
export async function pullImageViaEngine(options: EnginePullOptions): Promise<void> {
  const { image, signal } = options;
  const { repo, tag } = splitImageRef(image);
  const query = new URLSearchParams({ fromImage: repo, tag });
  if (options.platform) query.set('platform', options.platform);

  const stop = new AbortController();
  const combined = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const watchdog = new PullWatchdog(options.limits ?? DEFAULT_WATCHDOG, Date.now());
  let stalled: PullStalledError | null = null;
  const started = Date.now();
  let quietNoted = false;
  // Covers the time to open the stream too: a daemon that never answers is a stall like any other.
  const timer = setInterval(() => {
    if (!quietNoted && watchdog.phase() === 'start' && Date.now() - started >= (options.quietAfterMs ?? 30_000)) {
      quietNoted = true;
      options.onQuiet?.((options.limits ?? DEFAULT_WATCHDOG).startMs);
    }
    const stall = watchdog.check(Date.now());
    if (!stall || stalled) return;
    stalled = new PullStalledError(stall.phase, image, stall.idleMs);
    stop.abort();
  }, options.checkEveryMs ?? 1_000);

  const failWith = (err: unknown): never => {
    if (signal?.aborted) throw new Error('Cancelled');
    if (stalled) throw stalled;
    throw err;
  };

  try {
    const stream = await (options.open ?? openPullStream)({
      socketPath: options.socketPath,
      path: `/images/create?${query}`,
      headers: options.auth ? { 'X-Registry-Auth': options.auth } : {},
      signal: combined,
    }).catch((err: unknown) => {
      // The daemon refused before streaming (e.g. unauthorized): name the image, like stream errors do.
      if (err instanceof CommandError && !signal?.aborted && !stalled) {
        throw new CommandError({ message: `Could not pull ${image}: ${err.summary}`, command: `docker pull ${image}`, outputTail: [err.summary] });
      }
      return failWith(err);
    });

    let failure: string | null = null;
    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      const onLine = (line: string) => {
        if (!line.trim()) return;
        let msg: EngineMessage;
        try {
          msg = JSON.parse(line) as EngineMessage;
        } catch {
          return;
        }
        failure ??= engineError(msg);
        watchdog.observe(msg, Date.now());
        options.onMessage(msg);
      };
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        lines.forEach(onLine);
      });
      let ended = false;
      stream.on('end', () => {
        ended = true;
        onLine(buffer);
        resolve();
      });
      stream.on('error', reject);
      // Aborting destroys the stream without 'end' (the daemon then cancels the pull). A close
      // without 'end' otherwise means the connection dropped mid-pull: worth a retry.
      stream.on('close', () => {
        if (!ended) reject(new Error(combined.aborted ? 'aborted' : 'connection reset: Docker closed the pull stream early'));
      });
    }).catch(failWith);

    if (signal?.aborted) throw new Error('Cancelled');
    if (failure) {
      throw new CommandError({ message: `Could not pull ${image}: ${failure}`, command: `docker pull ${image}`, outputTail: [failure] });
    }
  } finally {
    clearInterval(timer);
  }
}
