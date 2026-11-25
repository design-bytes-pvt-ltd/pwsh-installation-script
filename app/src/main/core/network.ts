import { CommandError } from './errors';
import { isNetworkError, isRetryableText } from './networkErrors';

export { isNetworkError, isRetryableText } from './networkErrors';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

let currentFetch: FetchFn = (url, init) => fetch(url, init);

/**
 * Sets the fetch used for internet downloads. The app installs Electron's `net.fetch`, which goes
 * through Chromium's network stack: the system proxy (and PAC), and the OS certificate store, on
 * all three OSes. Node's own fetch ignores both. Tests keep the default.
 */
export function setNetworkFetch(fn: FetchFn): void {
  currentFetch = fn;
}

/** Fetch for internet requests (never for localhost services like Ollama). */
export function networkFetch(url: string, init?: RequestInit): Promise<Response> {
  return currentFetch(url, init);
}

/** All the text an error carries: message, command output and the `cause` chain (fetch puts the code there). */
export function errorText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error) {
      parts.push(current.message);
      if (current instanceof CommandError) parts.push(...current.outputTail);
      const code = (current as NodeJS.ErrnoException).code;
      if (code) parts.push(String(code));
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join('\n');
}

/**
 * Whether another attempt may fix this error. An error can decide for itself with a boolean
 * `networkRetryable` (download stalls say yes; a silent Docker stall says no, since a retry would
 * restart its unpacking); otherwise its text decides.
 */
export function isRetryableError(err: unknown): boolean {
  const own = (err as { networkRetryable?: unknown } | null)?.networkRetryable;
  if (typeof own === 'boolean') return own;
  return isRetryableText(errorText(err));
}

/** Hosts the install downloads from. Any HTTP answer (even 401 or 404) means the internet works. */
export const CONNECTIVITY_URLS = ['https://ollama.com', 'https://registry.ollama.ai/v2/', 'https://desktop.docker.com', 'https://ghcr.io/v2/'];

export interface Connectivity {
  online: boolean;
  unreachable: { url: string; reason: string }[];
}

export async function checkConnectivity(
  options: { timeoutMs?: number; urls?: string[]; fetch?: FetchFn; signal?: AbortSignal } = {}
): Promise<Connectivity> {
  const doFetch = options.fetch ?? networkFetch;
  const timeout = options.timeoutMs ?? 5_000;
  const results = await Promise.all(
    (options.urls ?? CONNECTIVITY_URLS).map(async (url) => {
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
      try {
        const res = await doFetch(url, { method: 'HEAD', signal, cache: 'no-store' });
        // Don't wait for a body we don't need.
        await res.body?.cancel().catch(() => {});
        return null;
      } catch (err) {
        return { url, reason: errorText(err).split('\n').filter(Boolean).slice(-1)[0] ?? 'unreachable' };
      }
    })
  );
  if (options.signal?.aborted) throw new Error('Cancelled');
  const unreachable = results.filter((r): r is { url: string; reason: string } => r !== null);
  return { online: unreachable.length < results.length, unreachable };
}

/** No connection for too long. Gets the `offline` hint. */
export class OfflineError extends CommandError {
  readonly networkRetryable = false;
  constructor(waitedMs: number) {
    const minutes = Math.max(1, Math.round(waitedMs / 60_000));
    super({ message: `No internet connection for ${minutes} minute${minutes === 1 ? '' : 's'}.` });
    this.name = 'OfflineError';
  }
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

export interface WaitOptions {
  signal?: AbortSignal;
  /** Give up after this long without a connection. */
  maxWaitMs?: number;
  pollMs?: number;
  /** Called after each failed check with the time waited so far. */
  onWaiting?: (elapsedMs: number) => void;
  /** Replaces the connectivity check (tests). */
  isOnline?: () => Promise<boolean>;
}

export const NETWORK_WAIT_MS = 600_000;

const defaultIsOnline = async () => (await checkConnectivity()).online;

/** Resolves once the internet answers again; throws OfflineError after `maxWaitMs`. */
export async function waitForNetwork(options: WaitOptions = {}): Promise<void> {
  const isOnline = options.isOnline ?? defaultIsOnline;
  const maxWaitMs = options.maxWaitMs ?? NETWORK_WAIT_MS;
  const started = Date.now();
  for (;;) {
    if (options.signal?.aborted) throw new Error('Cancelled');
    if (await isOnline()) return;
    const elapsed = Date.now() - started;
    if (elapsed >= maxWaitMs) throw new OfflineError(elapsed);
    options.onWaiting?.(elapsed);
    await delay(options.pollMs ?? 5_000, options.signal);
  }
}

export type NetworkRetryEvent =
  | { type: 'offline'; error: unknown }
  | { type: 'waiting'; elapsedMs: number }
  | { type: 'online'; waitedMs: number }
  | { type: 'retry'; attempt: number; maxAttempts: number; error: unknown };

export interface RetryOptions extends Omit<WaitOptions, 'onWaiting'> {
  /** Attempts while online; waiting for the connection doesn't use them up. */
  maxAttempts?: number;
  /** Pause before each retry while online, by attempt (the last value repeats). */
  backoffMs?: number[];
  /** How many times to wait for the connection before giving up. */
  maxWaits?: number;
  isRetryable?: (err: unknown) => boolean;
  onEvent?: (event: NetworkRetryEvent) => void;
}

/**
 * Runs `fn`, and when it fails with network trouble: waits for the connection if it is gone, or
 * pauses if it is up, then runs `fn` again. `fn` must pick up where it stopped (resume a download,
 * let Docker/Ollama reuse what they already have). Other errors are rethrown at once.
 */
export async function withNetworkRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { signal } = options;
  const maxAttempts = options.maxAttempts ?? 4;
  const backoff = options.backoffMs ?? [2_000, 5_000, 15_000];
  const maxWaits = options.maxWaits ?? 5;
  const isRetryable = options.isRetryable ?? isRetryableError;
  const isOnline = options.isOnline ?? defaultIsOnline;
  let attempt = 0;
  let waits = 0;
  for (let run = 1; ; run++) {
    try {
      return await fn(run);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (!isRetryable(err)) throw err;
      const online = await isOnline();
      if (signal?.aborted) throw new Error('Cancelled');
      if (!online) {
        if (++waits > maxWaits) throw err;
        options.onEvent?.({ type: 'offline', error: err });
        const started = Date.now();
        await waitForNetwork({ ...options, isOnline, onWaiting: (elapsedMs) => options.onEvent?.({ type: 'waiting', elapsedMs }) });
        options.onEvent?.({ type: 'online', waitedMs: Date.now() - started });
        continue;
      }
      if (++attempt >= maxAttempts) throw err;
      options.onEvent?.({ type: 'retry', attempt: attempt + 1, maxAttempts, error: err });
      await delay(backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0, signal);
    }
  }
}
