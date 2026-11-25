import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandError } from './errors';
import { type FetchFn, networkFetch, type NetworkRetryEvent, type RetryOptions, withNetworkRetry } from './network';

export interface DownloadProgress {
  completed: number;
  total: number | null;
  percent: number | null;
  /** Recent speed, once there is enough to measure. */
  bytesPerSec?: number | null;
  /** Seconds left at the recent speed, when the size is known. */
  etaSec?: number | null;
}

export interface DownloadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
  /** The connection dropped / came back, or a retry starts. */
  onNetwork?: (event: NetworkRetryEvent) => void;
  /** Called once when the download stays slow, with the speed and time left. */
  onSlow?: (bytesPerSec: number, etaSec: number | null) => void;
  /** Reuse a finished download at `destination` younger than this (default: always download). */
  reuseForMs?: number;
  fetch?: FetchFn;
  /** No bytes for this long: drop the connection and resume (default 60 s). */
  stallMs?: number;
  /** No response headers for this long (default 30 s). */
  connectTimeoutMs?: number;
  retry?: Pick<RetryOptions, 'maxAttempts' | 'backoffMs' | 'isOnline' | 'maxWaitMs' | 'pollMs' | 'maxWaits'>;
  /** Below this speed for `slowAfterMs`, `onSlow` fires (default 200 KB/s for 30 s). */
  slowBytesPerSec?: number;
  slowAfterMs?: number;
}

function fileName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || url);
  } catch {
    return url;
  }
}

/** No bytes for too long. The connection is dropped; the next attempt resumes. */
export class DownloadStalledError extends CommandError {
  readonly networkRetryable = true;
  constructor(url: string, idleMs: number) {
    super({ message: `No data received for ${Math.round(idleMs / 1000)} seconds while downloading ${fileName(url)}.` });
    this.name = 'DownloadStalledError';
  }
}

/** A download error worth another attempt that the text alone wouldn't show. */
class RetryableDownloadError extends CommandError {
  readonly networkRetryable = true;
}

interface PartMeta {
  url: string;
  /** ETag or Last-Modified of the response the part came from, for If-Range. */
  validator?: string;
  /** The server compressed the body (Content-Encoding): sizes don't match, so it can't resume. */
  encoded?: boolean;
}

function readMeta(file: string): PartMeta | null {
  try {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as PartMeta;
    return typeof meta.url === 'string' ? meta : null;
  } catch {
    return null;
  }
}

/** "bytes 100-199/1000" -> 1000 */
export function contentRangeTotal(header: string | null): number | null {
  const total = header?.match(/\/(\d+)\s*$/)?.[1];
  return total ? Number(total) : null;
}

/**
 * Downloads `url` to `destination`, resuming instead of starting over: bytes go to
 * `<destination>.part`, and each retry asks for the rest with a Range request (If-Range makes the
 * server send the whole file again if it changed). A connection that sends nothing for `stallMs`
 * is dropped and resumed; when the internet is gone, it waits for it (see withNetworkRetry).
 */
export async function downloadFile(url: string, destination: string, options: DownloadOptions = {}): Promise<void> {
  if (options.reuseForMs) {
    try {
      if (Date.now() - fs.statSync(destination).mtimeMs < options.reuseForMs) return;
    } catch {
      // Not downloaded yet.
    }
  }
  fs.rmSync(destination, { force: true });

  const part = `${destination}.part`;
  const metaFile = `${destination}.part.json`;
  const doFetch = options.fetch ?? networkFetch;
  const stallMs = options.stallMs ?? 60_000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
  const slowBps = options.slowBytesPerSec ?? 200_000;
  const slowAfterMs = options.slowAfterMs ?? 30_000;
  let slowSince: number | null = null;
  let slowNoted = false;

  const attempt = async (): Promise<void> => {
    let offset = 0;
    try {
      offset = fs.statSync(part).size;
    } catch {
      // Nothing yet.
    }
    const meta = readMeta(metaFile);
    if (offset > 0 && (meta?.url !== url || meta.encoded)) {
      fs.rmSync(part, { force: true });
      offset = 0;
    }
    // Ask for the bytes as stored: fetch would decompress an encoded body, so its length would
    // not match Content-Length and a Range request could not resume it.
    const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
    if (offset > 0) {
      headers.Range = `bytes=${offset}-`;
      if (meta?.validator) headers['If-Range'] = meta.validator;
    }

    const stop = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
    let gotHeaders = false;
    let lastData = Date.now();
    let stalledAfter = 0;
    const watchdog = setInterval(() => {
      const limit = gotHeaders ? stallMs : connectTimeoutMs;
      if (!stalledAfter && Date.now() - lastData >= limit) {
        stalledAfter = limit;
        stop.abort();
      }
    }, 1_000);
    const rethrow = (err: unknown): never => {
      if (stalledAfter && !options.signal?.aborted) throw new DownloadStalledError(url, stalledAfter);
      throw err;
    };

    try {
      const res = await doFetch(url, { headers, signal }).catch(rethrow);
      gotHeaders = true;
      lastData = Date.now();
      if (res.status === 416 && offset > 0) {
        // The part no longer fits the file on the server: start over.
        fs.rmSync(part, { force: true });
        throw new RetryableDownloadError({ message: `Could not resume ${fileName(url)}; starting it again.` });
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw new CommandError({ message: `Failed to download ${url}: HTTP ${res.status} ${res.statusText}`.trim() });
      }
      const encoding = (res.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
      const encoded = encoding !== '' && encoding !== 'identity';
      const append = res.status === 206 && offset > 0 && !encoded;
      if (!append) offset = 0;
      const lengthHeader = res.headers.get('content-length');
      // An encoded body arrives decompressed, so its size is unknown up front.
      const total = encoded ? null : append ? contentRangeTotal(res.headers.get('content-range')) : lengthHeader ? Number(lengthHeader) : null;
      const etag = res.headers.get('etag');
      const validator = etag && !etag.startsWith('W/') ? etag : (res.headers.get('last-modified') ?? undefined);
      fs.writeFileSync(metaFile, JSON.stringify({ url, validator, ...(encoded && { encoded }) } satisfies PartMeta));

      const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
      const outError = new Promise<never>((_, reject) => out.once('error', reject));
      outError.catch(() => {});
      let completed = offset;
      const samples: { t: number; bytes: number }[] = [{ t: Date.now(), bytes: completed }];
      let lastReport = 0;
      const report = (force: boolean) => {
        const now = Date.now();
        if (!force && now - lastReport < 250) return;
        lastReport = now;
        while (samples.length > 1 && now - samples[0].t > 10_000) samples.shift();
        const span = (now - samples[0].t) / 1000;
        const bytesPerSec = span >= 2 ? (completed - samples[0].bytes) / span : null;
        const etaSec = bytesPerSec && total ? Math.max(0, (total - completed) / bytesPerSec) : null;
        options.onProgress?.({
          completed,
          total,
          percent: total && total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : null,
          bytesPerSec: bytesPerSec ? Math.round(bytesPerSec) : null,
          etaSec,
        });
        if (bytesPerSec !== null && bytesPerSec < slowBps) {
          slowSince ??= now;
          if (!slowNoted && now - slowSince >= slowAfterMs) {
            slowNoted = true;
            options.onSlow?.(Math.round(bytesPerSec), etaSec);
          }
        } else if (bytesPerSec !== null) {
          slowSince = null;
        }
      };

      const reader = res.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read().catch(rethrow);
          if (chunk.done) break;
          const buf = Buffer.from(chunk.value);
          lastData = Date.now();
          completed += buf.length;
          samples.push({ t: lastData, bytes: completed });
          if (!out.write(buf)) await Promise.race([once(out, 'drain'), outError]);
          report(false);
        }
      } finally {
        // Frees the connection if we stopped early; a no-op once the body is done.
        await reader.cancel().catch(() => {});
        await new Promise<void>((resolve) => out.end(resolve));
      }
      report(true);
      if (total !== null && completed !== total) {
        if (completed > total) fs.rmSync(part, { force: true });
        throw new RetryableDownloadError({ message: `The download of ${fileName(url)} was cut short (${completed} of ${total} bytes).` });
      }
    } finally {
      clearInterval(watchdog);
    }
  };

  await withNetworkRetry(attempt, { signal: options.signal, ...options.retry, onEvent: options.onNetwork });
  fs.renameSync(part, destination);
  fs.rmSync(metaFile, { force: true });
}

const CACHE_ROOT = path.join(os.tmpdir(), 'enterprise-brain-installer');

/** A directory only this user can write, safe to keep files in between runs. Throws if not. */
function ownedDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return; // %TEMP% is per user on Windows.
  const st = fs.lstatSync(dir);
  // A shared /tmp lets other users create this path first, or plant a symlink.
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.()) {
    throw new Error(`${dir} is not a private directory`);
  }
}

/**
 * Where to download a large installer so that a failed or cancelled download can resume on the
 * next run (Retry). Falls back to a fresh temp dir (no resume) when the cache dir isn't private.
 * Delete with discardDownload() once installed.
 */
export function downloadCachePath(url: string, name: string): string {
  try {
    const downloads = path.join(CACHE_ROOT, 'downloads');
    ownedDir(CACHE_ROOT);
    ownedDir(downloads);
    const dir = path.join(downloads, crypto.createHash('sha256').update(url).digest('hex').slice(0, 16));
    ownedDir(dir);
    return path.join(dir, name);
  } catch {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eb-download-')), name);
  }
}

/** Removes a downloaded installer and its partial-download files. Best effort. */
export function discardDownload(file: string): void {
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}
