import { afterEach, describe, expect, it, vi } from 'vitest';
import { pullOrUseLocal } from '../containers';
import { PullStalledError } from '../enginePull';
import { CommandError, createErrorReport } from '../errors';
import { networkReporter } from '../events';
import {
  checkConnectivity,
  errorText,
  isNetworkError,
  isRetryableError,
  type NetworkRetryEvent,
  OfflineError,
  waitForNetwork,
  withNetworkRetry,
} from '../network';
import type { InstallEvent } from '../../../shared/types';

/** What each tool prints when the internet is gone or flaky, as captured from the real thing. */
const NETWORK_FAILURES: Record<string, string> = {
  'node fetch': 'fetch failed\ngetaddrinfo ENOTFOUND ollama.com\nENOTFOUND',
  'electron net.fetch': 'net::ERR_INTERNET_DISCONNECTED',
  'electron proxy': 'net::ERR_PROXY_CONNECTION_FAILED',
  'docker login': 'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host',
  'docker pull': 'failed to do request: Head "https://ghcr.io/v2/x/manifests/latest": dial tcp 140.82.114.33:443: i/o timeout',
  'ollama pull': 'pull model manifest: Get "https://registry.ollama.ai/v2/library/qwen3/manifests/8b": dial tcp: lookup registry.ollama.ai: no such host',
  curl: 'curl: (6) Could not resolve host: ollama.com',
  apt: 'Err:1 http://archive.ubuntu.com/ubuntu jammy InRelease\n  Temporary failure resolving \'archive.ubuntu.com\'',
  dnf: "Curl error (6): Couldn't resolve host name for https://download.docker.com/linux/fedora/docker-ce.repo",
  winget: 'InternetOpenUrl() failed.\n0x80072ee7 : unknown error',
  powershell: 'Invoke-WebRequest : The remote name could not be resolved: \'desktop.docker.com\'',
};

const NOT_NETWORK: Record<string, string> = {
  'registry refusal': 'Error response from daemon: error from registry: unauthorized',
  'docker daemon down': 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running? dial unix /var/run/docker.sock: connect: connection refused',
  'ollama server down': 'fetch failed\nconnect ECONNREFUSED 127.0.0.1:11434\nECONNREFUSED',
  'disk full': 'write /var/lib/docker/tmp: no space left on device',
  signature: 'Refusing to run OllamaSetup.exe: its digital signature is missing or invalid.',
};

describe('network errors', () => {
  for (const [source, text] of Object.entries(NETWORK_FAILURES)) {
    it(`recognises ${source}`, () => {
      expect(isNetworkError(text)).toBe(true);
      // The Ollama line also says "pull model manifest": it must still read as a network problem.
      expect(createErrorReport({ step: 'x', message: text }).hintId).toBe('network');
    });
  }
  for (const [what, text] of Object.entries(NOT_NETWORK)) {
    it(`does not mistake ${what} for the network`, () => {
      expect(isNetworkError(text)).toBe(false);
      expect(isRetryableError(new Error(text))).toBe(false);
    });
  }

  it('reads the code fetch hides in the cause', () => {
    const err = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo EAI_AGAIN ghcr.io'), { code: 'EAI_AGAIN' }) });
    expect(errorText(err)).toBe('fetch failed\ngetaddrinfo EAI_AGAIN ghcr.io\nEAI_AGAIN');
    expect(isRetryableError(err)).toBe(true);
  });

  it('lets an error decide for itself', () => {
    expect(isRetryableError(new PullStalledError('download', 'ghcr.io/x:1', 120_000))).toBe(true);
    // Retrying a silent stall would restart Docker's unpacking.
    expect(isRetryableError(new PullStalledError('start', 'ghcr.io/x:1', 600_000))).toBe(false);
    expect(isRetryableError(new OfflineError(600_000))).toBe(false);
  });

  it('retries a busy server, not a refusal', () => {
    expect(isRetryableError(new Error('Failed to download https://x/y: HTTP 503 Service Unavailable'))).toBe(true);
    expect(isRetryableError(new Error('toomanyrequests: rate limit exceeded'))).toBe(true);
    expect(isRetryableError(new Error('Failed to download https://x/y: HTTP 404 Not Found'))).toBe(false);
  });
});

describe('checkConnectivity', () => {
  it('counts any HTTP answer, even 401, as online', async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('ghcr')) return new Response(null, { status: 401 });
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) });
    });
    const res = await checkConnectivity({ fetch, urls: ['https://ghcr.io/v2/', 'https://ollama.com'] });
    expect(res.online).toBe(true);
    expect(res.unreachable).toEqual([{ url: 'https://ollama.com', reason: 'ENOTFOUND' }]);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'HEAD' });
  });

  it('is offline when nothing answers', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    });
    expect((await checkConnectivity({ fetch, urls: ['https://a', 'https://b'] })).online).toBe(false);
  });
});

describe('waiting for the network', () => {
  afterEach(() => vi.useRealTimers());
  const offlineFor = (checks: number) => {
    let n = 0;
    return async () => ++n > checks;
  };

  it('resumes as soon as the connection is back', async () => {
    vi.useFakeTimers();
    const waited: number[] = [];
    const done = waitForNetwork({ isOnline: offlineFor(6), pollMs: 5_000, onWaiting: (ms) => waited.push(ms) });
    await vi.advanceTimersByTimeAsync(30_000);
    await done;
    expect(waited).toEqual([0, 5_000, 10_000, 15_000, 20_000, 25_000]);
  });

  it('gives up after 10 minutes with the offline hint', async () => {
    vi.useFakeTimers();
    const done = waitForNetwork({ isOnline: async () => false }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(600_000);
    const err = await done;
    expect(err).toBeInstanceOf(OfflineError);
    expect(err.message).toBe('No internet connection for 10 minutes.');
    expect(createErrorReport({ step: 'Docker', message: err.message }).hint).toBe(
      "This computer isn't connected to the internet. Check Wi-Fi, VPN or proxy, then click Retry. Downloads continue where they stopped."
    );
  });

  it('stops waiting when cancelled', async () => {
    const ac = new AbortController();
    const done = waitForNetwork({ isOnline: async () => false, pollMs: 50, signal: ac.signal }).catch((e) => e);
    setTimeout(() => ac.abort(), 20);
    expect((await done).message).toBe('Cancelled');
  });
});

describe('withNetworkRetry', () => {
  const dropped = () => new CommandError({ message: 'Failed', outputTail: ['dial tcp: lookup ghcr.io: no such host'] });

  it('waits out an outage (without using up attempts), then runs again', async () => {
    let online = false;
    const events: NetworkRetryEvent['type'][] = [];
    const fn = vi.fn(async (run: number) => {
      if (run < 3) {
        online = run === 2; // the first drop finds the internet gone; the second finds it up
        throw dropped();
      }
      return 'ok';
    });
    let checks = 0;
    const result = await withNetworkRetry(fn, {
      maxAttempts: 2,
      backoffMs: [0],
      pollMs: 1,
      isOnline: async () => online || ++checks > 2,
      onEvent: (e) => events.push(e.type),
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(events).toEqual(['offline', 'waiting', 'online', 'retry']);
  });

  it('rethrows anything that is not network trouble, at once', async () => {
    const fn = vi.fn(async () => {
      throw new Error('error from registry: unauthorized');
    });
    await expect(withNetworkRetry(fn, { isOnline: async () => true })).rejects.toThrow('unauthorized');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('stops after the last attempt while online', async () => {
    const fn = vi.fn(async () => {
      throw dropped();
    });
    await expect(withNetworkRetry(fn, { maxAttempts: 3, backoffMs: [0], isOnline: async () => true })).rejects.toThrow('Failed');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('reports waits on the step as a ticking label and log lines', () => {
    const events: InstallEvent[] = [];
    const report = networkReporter((e) => events.push(e), 'Docker', 'downloading Docker.dmg');
    report({ type: 'offline', error: dropped() });
    report({ type: 'waiting', elapsedMs: 80_000 });
    report({ type: 'online', waitedMs: 95_000 });
    expect(events.map((e) => (e.type === 'log' ? `${e.level}: ${e.message}` : e.type === 'progress' ? `bar: ${e.label}` : e.type))).toEqual([
      'warn: No internet connection while downloading Docker.dmg (Failed). Waiting for it to come back...',
      'bar: Waiting for the internet connection... 0s (downloading Docker.dmg continues automatically)',
      'bar: Waiting for the internet connection... 1m 20s (downloading Docker.dmg continues automatically)',
      'info: The internet connection is back after 1m 35s; continuing downloading Docker.dmg.',
    ]);
  });
});

describe('pullOrUseLocal', () => {
  const setup = (o: { online: boolean; local: boolean; pull?: () => Promise<void> }) => {
    const warnings: string[] = [];
    const pull = vi.fn(o.pull ?? (async () => {}));
    const run = () =>
      pullOrUseLocal({ pull, isOnline: async () => o.online, haveLocal: async () => o.local, warn: (m) => warnings.push(m) });
    return { run, pull, warnings };
  };

  it('uses the dev container already here when offline, without trying to sign in or pull', async () => {
    const t = setup({ online: false, local: true });
    expect(await t.run()).toBe('local');
    expect(t.pull).not.toHaveBeenCalled();
    expect(t.warnings).toEqual(['No internet connection. Using the dev container already on this computer (it may not be the newest).']);
  });

  it('still downloads when offline with nothing local (the pull then waits for the connection)', async () => {
    const t = setup({ online: false, local: false });
    expect(await t.run()).toBe('pulled');
    expect(t.pull).toHaveBeenCalledOnce();
  });

  it('falls back to the local copy when the download fails for lack of network', async () => {
    const t = setup({
      online: true,
      local: true,
      pull: async () => {
        throw new OfflineError(600_000);
      },
    });
    expect(await t.run()).toBe('local');
    expect(t.warnings[0]).toBe(
      'Could not download the newest dev container (No internet connection for 10 minutes.). Using the dev container already on this computer (it may not be the newest).'
    );
  });

  it('does not hide other failures behind the local copy', async () => {
    const t = setup({
      online: true,
      local: true,
      pull: async () => {
        throw new Error('error from registry: unauthorized');
      },
    });
    await expect(t.run()).rejects.toThrow('unauthorized');
  });
});
