import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentRangeTotal, DownloadStalledError, downloadCachePath, downloadFile, discardDownload } from '../downloader';
import { createErrorReport } from '../errors';
import type { NetworkRetryEvent } from '../network';

const FILE = crypto.randomBytes(300_000);
const ETAG = '"v1"';

/** What the server does on each request, in order (the last one repeats). */
type Behaviour = 'ok' | 'drop-half' | 'ignore-range' | 'stall-half' | 'not-found' | 'gzip';
let script: Behaviour[] = [];
let requests: { range?: string; ifRange?: string }[] = [];

const server = http.createServer((req, res) => {
  const behaviour = script[Math.min(requests.length, script.length - 1)];
  requests.push({ range: req.headers.range, ifRange: req.headers['if-range'] as string | undefined });
  if (behaviour === 'gzip') {
    // A server that compresses anyway: Content-Length is the compressed size.
    const gz = zlib.gzipSync(FILE);
    res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': gz.length });
    return res.end(gz);
  }
  if (behaviour === 'not-found') {
    res.writeHead(404, 'Not Found');
    return res.end();
  }
  const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
  const start = range && behaviour !== 'ignore-range' && req.headers['if-range'] === ETAG ? Number(range[1]) : 0;
  const body = FILE.subarray(start);
  const headers: http.OutgoingHttpHeaders = { 'content-length': body.length, etag: ETAG };
  if (start > 0) headers['content-range'] = `bytes ${start}-${FILE.length - 1}/${FILE.length}`;
  res.writeHead(start > 0 ? 206 : 200, headers);
  if (behaviour === 'drop-half') {
    res.write(body.subarray(0, 100_000), () => setTimeout(() => res.destroy(), 20));
  } else if (behaviour === 'stall-half') {
    res.write(body.subarray(0, 100_000)); // ... and never more: the client's watchdog must notice.
  } else {
    res.end(body);
  }
});

let base = '';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downloader-test-'));
let n = 0;
const dest = () => path.join(dir, `file-${++n}.bin`);
const fast = { isOnline: async () => true, backoffMs: [0] };

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/files/OllamaSetup.exe`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

function run(behaviours: Behaviour[]) {
  script = behaviours;
  requests = [];
}

describe('downloadFile', () => {
  it('downloads, reporting progress up to the full size', async () => {
    run(['ok']);
    const file = dest();
    const seen: number[] = [];
    await downloadFile(base, file, { onProgress: (p) => seen.push(p.completed), retry: fast });
    expect(fs.readFileSync(file).equals(FILE)).toBe(true);
    expect(seen.at(-1)).toBe(FILE.length);
    expect(fs.existsSync(`${file}.part`)).toBe(false);
  });

  it('resumes where a dropped connection stopped', async () => {
    run(['drop-half', 'ok']);
    const file = dest();
    const events: NetworkRetryEvent['type'][] = [];
    await downloadFile(base, file, { retry: fast, onNetwork: (e) => events.push(e.type) });
    expect(fs.readFileSync(file).equals(FILE)).toBe(true);
    expect(requests).toEqual([{}, { range: 'bytes=100000-', ifRange: ETAG }]);
    expect(events).toEqual(['retry']);
  });

  it('starts over cleanly when the server ignores the range', async () => {
    run(['drop-half', 'ignore-range']);
    const file = dest();
    await downloadFile(base, file, { retry: fast });
    expect(fs.readFileSync(file).equals(FILE)).toBe(true);
    expect(requests[1].range).toBe('bytes=100000-');
  });

  it('drops a connection that stops sending, then resumes', async () => {
    run(['stall-half', 'ok']);
    const file = dest();
    const errors: unknown[] = [];
    await downloadFile(base, file, {
      retry: fast,
      stallMs: 1_000,
      onNetwork: (e) => e.type === 'retry' && errors.push(e.error),
    });
    expect(fs.readFileSync(file).equals(FILE)).toBe(true);
    expect(errors[0]).toBeInstanceOf(DownloadStalledError);
    expect((errors[0] as Error).message).toBe('No data received for 1 seconds while downloading OllamaSetup.exe.');
    expect(requests[1].range).toBe('bytes=100000-');
  }, 10_000);

  it('waits for the internet to come back, then continues', async () => {
    run(['drop-half', 'ok']);
    const file = dest();
    let checks = 0;
    const events: string[] = [];
    await downloadFile(base, file, {
      retry: {
        pollMs: 20,
        // Offline for the first two checks (after the failure, and the first one while waiting).
        isOnline: async () => ++checks > 2,
      },
      onNetwork: (e) => events.push(e.type),
    });
    expect(fs.readFileSync(file).equals(FILE)).toBe(true);
    expect(events).toEqual(['offline', 'waiting', 'online']);
  });

  it('fails at once on a missing file, with no retry', async () => {
    run(['not-found']);
    const err = await downloadFile(base, dest(), { retry: fast }).catch((e) => e);
    expect(err.message).toBe(`Failed to download ${base}: HTTP 404 Not Found`);
    expect(requests).toHaveLength(1);
  });

  it('gives up with the offline hint when the internet stays away', async () => {
    run(['drop-half']);
    const err = await downloadFile(base, dest(), { retry: { isOnline: async () => false, maxWaitMs: 50, pollMs: 10 } }).catch((e) => e);
    expect(err.message).toBe('No internet connection for 1 minute.');
    expect(createErrorReport({ step: 'Ollama', message: err.message }).hintId).toBe('offline');
  });

  it('keeps the partial download when cancelled, for the next run', async () => {
    run(['stall-half']);
    const file = dest();
    const ac = new AbortController();
    const pending = downloadFile(base, file, { signal: ac.signal, retry: fast }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    await pending;
    expect(fs.statSync(`${file}.part`).size).toBe(100_000);
    run(['ok']);
    await downloadFile(base, file, { retry: fast });
    expect(requests[0].range).toBe('bytes=100000-');
    expect(fs.readFileSync(file).equals(FILE)).toBe(true);
  });

  it('reuses a recent finished download', async () => {
    run(['ok']);
    const file = dest();
    await downloadFile(base, file, { retry: fast });
    await downloadFile(base, file, { retry: fast, reuseForMs: 60_000 });
    expect(requests).toHaveLength(1);
  });

  it('keeps cached downloads per URL, in a private directory', () => {
    const a = downloadCachePath('https://example.com/a.dmg', 'a.dmg');
    expect(path.basename(a)).toBe('a.dmg');
    expect(downloadCachePath('https://example.com/a.dmg', 'a.dmg')).toBe(a);
    expect(path.dirname(downloadCachePath('https://example.com/b.dmg', 'b.dmg'))).not.toBe(path.dirname(a));
    if (process.platform !== 'win32') expect(fs.statSync(path.dirname(a)).mode & 0o077).toBe(0);
    discardDownload(a);
    expect(fs.existsSync(path.dirname(a))).toBe(false);
  });

  it('accepts a compressed body without mistaking it for a cut-short download', async () => {
    run(['gzip']);
    const file = dest();
    await downloadFile(base, file, { retry: fast });
    expect(fs.readFileSync(file).equals(FILE)).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it('reads the total size from Content-Range', () => {
    expect(contentRangeTotal('bytes 100-299999/300000')).toBe(300_000);
    expect(contentRangeTotal('bytes 0-9/*')).toBeNull();
    expect(contentRangeTotal(null)).toBeNull();
  });
});
