import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pullImages, registryOf } from '../containers';
import {
  encodeRegistryAuth,
  EngineUnavailableError,
  type OpenPullStream,
  parseDockerHost,
  pullImageViaEngine,
  PullStalledError,
  PullWatchdog,
  readDockerLogin,
  splitImageRef,
} from '../enginePull';
import { CommandError, createErrorReport, findHint } from '../errors';
import type { ExecResult } from '../exec';
import type { InstallEvent } from '../../../shared/types';

const IMAGE = 'ghcr.io/design-bytes-pvt-ltd/ubuntu-nix-hm:latest';
const line = (o: object) => `${JSON.stringify(o)}\n`;

/** A fake daemon: each call to `open` gets the next script, which writes to the stream it returns. */
function fakeDaemon(...scripts: Array<(s: PassThrough) => void>) {
  const calls: { path: string; headers: Record<string, string>; stream: PassThrough }[] = [];
  const open: OpenPullStream = async (req) => {
    const stream = new PassThrough();
    req.signal.addEventListener('abort', () => stream.destroy(), { once: true });
    calls.push({ path: req.path, headers: req.headers, stream });
    const script = scripts[Math.min(calls.length - 1, scripts.length - 1)];
    setImmediate(() => script(stream));
    return stream;
  };
  return { open, calls };
}

const hangs = (s: PassThrough) => s.write(line({ status: 'Pulling from design-bytes-pvt-ltd/ubuntu-nix-hm', id: 'latest' }));
const bytesStop = (s: PassThrough) =>
  s.write(line({ status: 'Downloading', id: 'aaaaaaaaaaaa', progressDetail: { current: 1_000_000, total: 100_000_000 } }));
const succeeds = (s: PassThrough) => {
  s.write(line({ status: 'Pulling from design-bytes-pvt-ltd/ubuntu-nix-hm', id: 'latest' }));
  s.write(line({ status: 'Pulling fs layer', id: 'aaaaaaaaaaaa' }));
  s.write(line({ status: 'Downloading', id: 'aaaaaaaaaaaa', progressDetail: { current: 50_000_000, total: 100_000_000 } }));
  s.write(line({ status: 'Download complete', id: 'aaaaaaaaaaaa' }));
  s.write(line({ status: 'Pull complete', id: 'aaaaaaaaaaaa' }));
  s.end(line({ status: `Status: Downloaded newer image for ${IMAGE}` }));
};

describe('engine pull helpers', () => {
  it('finds the daemon socket behind a docker host', () => {
    expect(parseDockerHost('unix:///Users/me/.docker/run/docker.sock\n')).toBe('/Users/me/.docker/run/docker.sock');
    expect(parseDockerHost('npipe:////./pipe/dockerDesktopLinuxEngine')).toBe('\\\\.\\pipe\\dockerDesktopLinuxEngine');
    expect(parseDockerHost('tcp://10.0.0.5:2376')).toBeNull();
    expect(parseDockerHost('ssh://me@host')).toBeNull();
    expect(parseDockerHost('')).toBeNull();
  });

  it('encodes X-Registry-Auth as padded base64url', () => {
    // Regression: unpadded base64url is read by the daemon as "no credentials" -> unauthorized.
    const header = encodeRegistryAuth({ username: 'bot', password: 'p>?' }, 'ghcr.io');
    expect(header.length % 4).toBe(0);
    expect(header).not.toMatch(/[+/]/);
    const json = Buffer.from(header.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(JSON.parse(json)).toEqual({ username: 'bot', password: 'p>?', serveraddress: 'ghcr.io' });
  });

  it('splits image references', () => {
    expect(splitImageRef(IMAGE)).toEqual({ repo: 'ghcr.io/design-bytes-pvt-ltd/ubuntu-nix-hm', tag: 'latest' });
    expect(splitImageRef('localhost:5000/app')).toEqual({ repo: 'localhost:5000/app', tag: 'latest' });
    expect(splitImageRef('ghcr.io/x/y@sha256:abc')).toEqual({ repo: 'ghcr.io/x/y', tag: 'sha256:abc' });
    expect(registryOf(IMAGE)).toBe('ghcr.io');
    expect(registryOf('debian:bookworm')).toBeNull();
    expect(registryOf('library/debian')).toBeNull();
  });

  describe('readDockerLogin', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-config-'));
    const write = (config: object) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
    const helper = (stores: Record<string, Record<string, string>>) => {
      const calls: string[] = [];
      const exec = (async (cmd: string, _args?: string[], opts?: { input?: string }) => {
        calls.push(`${cmd} ${opts?.input}`);
        const secret = stores[cmd]?.[opts?.input ?? ''];
        if (!secret) throw new CommandError({ message: 'credentials not found in native keychain' });
        return { exitCode: 0, stdout: JSON.stringify({ ServerURL: opts?.input, Username: 'bot', Secret: secret }), stderr: '' } as ExecResult;
      }) as never;
      return { exec, calls };
    };

    it('asks the registry-specific helper before the default store', async () => {
      write({ credsStore: 'desktop', credHelpers: { 'ghcr.io': 'osxkeychain' } });
      const { exec, calls } = helper({ 'docker-credential-osxkeychain': { 'ghcr.io': 'from-keychain' } });
      expect(await readDockerLogin('ghcr.io', { env: {}, configDir: dir, exec })).toEqual({ username: 'bot', password: 'from-keychain' });
      expect(calls).toEqual(['docker-credential-osxkeychain ghcr.io']);
    });

    it('tries the https:// key, then plain auths entries', async () => {
      write({ credsStore: 'desktop' });
      const https = helper({ 'docker-credential-desktop': { 'https://ghcr.io': 's' } });
      expect(await readDockerLogin('ghcr.io', { env: {}, configDir: dir, exec: https.exec })).toEqual({ username: 'bot', password: 's' });

      write({ credsStore: 'desktop', auths: { 'ghcr.io': { auth: Buffer.from('bot:pa:ss').toString('base64') } } });
      const none = helper({});
      expect(await readDockerLogin('ghcr.io', { env: {}, configDir: dir, exec: none.exec })).toEqual({ username: 'bot', password: 'pa:ss' });
    });

    it('returns null when not signed in', async () => {
      write({ credsStore: 'desktop', auths: { 'ghcr.io': {} } });
      expect(await readDockerLogin('ghcr.io', { env: {}, configDir: dir, exec: helper({}).exec })).toBeNull();
      expect(await readDockerLogin('ghcr.io', { env: {}, configDir: path.join(dir, 'missing') })).toBeNull();
    });
  });

  it('counts only new bytes or new layer states as progress', () => {
    const limits = { startMs: 60, downloadMs: 120, extractMs: 600 };
    const dog = new PullWatchdog(limits, 0);
    dog.observe({ status: 'Pulling from x', id: 'latest' }, 10);
    // The tag line is not a layer: still waiting for the download to start.
    expect(dog.check(59)).toBeNull();
    expect(dog.check(60)).toEqual({ phase: 'start', idleMs: 60 });

    dog.observe({ status: 'Downloading', id: 'aaaaaaaaaaaa', progressDetail: { current: 5, total: 10 } }, 100);
    // The daemon repeats lines with the same byte count: that is not progress.
    dog.observe({ status: 'Downloading', id: 'aaaaaaaaaaaa', progressDetail: { current: 5, total: 10 } }, 200);
    expect(dog.check(220)).toEqual({ phase: 'download', idleMs: 120 });
    dog.observe({ status: 'Downloading', id: 'aaaaaaaaaaaa', progressDetail: { current: 6, total: 10 } }, 220);
    expect(dog.check(300)).toBeNull();

    dog.observe({ status: 'Extracting', id: 'aaaaaaaaaaaa' }, 300);
    expect(dog.check(800)).toBeNull();
    expect(dog.check(900)).toEqual({ phase: 'extract', idleMs: 600 });
  });
});

describe('pullImageViaEngine', () => {
  afterEach(() => vi.useRealTimers());
  const base = { socketPath: '/x.sock', image: IMAGE, platform: 'linux/amd64' };

  it('streams messages and asks for the image, tag and platform', async () => {
    const daemon = fakeDaemon(succeeds);
    const seen: string[] = [];
    await pullImageViaEngine({ ...base, auth: 'abc=', open: daemon.open, onMessage: (m) => seen.push(m.status ?? '') });
    expect(seen.at(-1)).toMatch(/^Status: Downloaded newer image/);
    expect(daemon.calls[0].path).toBe(
      '/images/create?fromImage=ghcr.io%2Fdesign-bytes-pvt-ltd%2Fubuntu-nix-hm&tag=latest&platform=linux%2Famd64'
    );
    expect(daemon.calls[0].headers).toEqual({ 'X-Registry-Auth': 'abc=' });
  });

  it('fails with the registry error, which gets the registry hint', async () => {
    // Captured from Docker 29: the failure arrives as a bare {"message": ...} line.
    const daemon = fakeDaemon((s) => s.end(line({ message: 'error from registry: unauthorized\nunauthorized' })));
    const err = await pullImageViaEngine({ ...base, open: daemon.open, onMessage: () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect(createErrorReport({ step: 'Containers', message: err.message }).hintId).toBe('registry-denied');
  });

  it('waits out a silent Docker for 10 minutes, noting why, then gives up', async () => {
    vi.useFakeTimers();
    const daemon = fakeDaemon(hangs);
    const quiet = vi.fn();
    const pending = pullImageViaEngine({ ...base, open: daemon.open, onMessage: () => {}, onQuiet: quiet }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(quiet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(quiet).toHaveBeenCalledOnce();
    expect(quiet).toHaveBeenCalledWith(600_000);
    // Regression: Docker unpacks already-downloaded layers without a word (15 GB took 70 s), and a
    // 60 s limit cancelled it every time just before the end.
    await vi.advanceTimersByTimeAsync(560_000);
    expect(daemon.calls[0].stream.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await pending;
    expect(err).toBeInstanceOf(PullStalledError);
    expect(err.phase).toBe('start');
    expect(err.message).toBe('The dev container download made no progress: Docker reported nothing for 10 minutes.');
    expect(quiet).toHaveBeenCalledOnce();
    // Closing the stream is what makes the daemon cancel its pull.
    expect(daemon.calls[0].stream.destroyed).toBe(true);
    expect(findHint(err.message)?.id).toBe('pull-stalled');
  });

  it('gives up when bytes stop moving', async () => {
    vi.useFakeTimers();
    const daemon = fakeDaemon((s) => {
      s.write(line({ status: 'Downloading', id: 'aaaaaaaaaaaa', progressDetail: { current: 1, total: 10 } }));
      // Same count again and again: the daemon's ticker, not progress.
      setInterval(() => s.write(line({ status: 'Downloading', id: 'aaaaaaaaaaaa', progressDetail: { current: 1, total: 10 } })), 500);
    });
    const pending = pullImageViaEngine({ ...base, open: daemon.open, onMessage: () => {} }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(125_000);
    const err = await pending;
    expect(err).toBeInstanceOf(PullStalledError);
    expect(err.message).toBe('The dev container download stalled: no data from ghcr.io for 2 minutes.');
  });

  it('stops at once when cancelled', async () => {
    const daemon = fakeDaemon(hangs);
    const ac = new AbortController();
    const pending = pullImageViaEngine({ ...base, signal: ac.signal, open: daemon.open, onMessage: () => {} }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    expect((await pending).message).toBe('Cancelled');
  });

  it('treats a stream that drops mid-pull as a network problem', async () => {
    const daemon = fakeDaemon((s) => s.destroy());
    const err = await pullImageViaEngine({ ...base, open: daemon.open, onMessage: () => {} }).catch((e) => e);
    expect(err.message).toMatch(/connection reset/);
  });

  it('passes on an unreachable socket so the caller can fall back', async () => {
    const open: OpenPullStream = async () => {
      throw new EngineUnavailableError(Object.assign(new Error('connect ENOENT /x.sock'), { code: 'ENOENT' }));
    };
    await expect(pullImageViaEngine({ ...base, open, onMessage: () => {} })).rejects.toBeInstanceOf(EngineUnavailableError);
  });
});

// pullImages end to end, with a stub docker CLI (a shell script) and a fake daemon.
describe.skipIf(process.platform === 'win32')('pullImages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-images-'));
  const compose = path.join(dir, 'docker-compose.yml');
  fs.writeFileSync(compose, 'services: {}\n');
  const config = JSON.stringify({ services: { devbox: { image: IMAGE, platform: 'linux/amd64' } } });
  const manifest = JSON.stringify({ Descriptor: {}, OCIManifest: { layers: [{ digest: `sha256:${'a'.repeat(64)}`, size: 100_000_000 }] } });

  /** A docker CLI that answers `compose config` and `manifest inspect` (or refuses the manifest). */
  function stubCli(manifestFails?: string): string {
    const cli = path.join(dir, `docker-${Math.random().toString(36).slice(2)}`);
    const manifestBranch = manifestFails ? `echo '${manifestFails}' >&2; exit 1` : `echo '${manifest}'`;
    fs.writeFileSync(
      cli,
      `#!/bin/sh\ncase "$*" in\n  *" config "*) echo '${config}' ;;\n  "manifest "*) ${manifestBranch} ;;\n  *) echo "unexpected: $*" >&2; exit 2 ;;\nesac\n`,
      { mode: 0o755 }
    );
    return cli;
  }

  const run = (cli: string, daemon: ReturnType<typeof fakeDaemon>, retryDelaysMs = [0]) => {
    const events: InstallEvent[] = [];
    const promise = pullImages(cli, compose, { env: process.env }, (e) => events.push(e), {
      socketPath: '/x.sock',
      open: daemon.open,
      retryDelaysMs,
      network: { isOnline: async () => true },
      credentials: { username: 'bot', token: 't' },
      watchdog: { startMs: 50, downloadMs: 50, extractMs: 50 },
    });
    return { promise, events };
  };
  const logs = (events: InstallEvent[]) => events.flatMap((e) => (e.type === 'log' ? [e.message] : []));

  it('fails in seconds, without downloading, when the registry refuses access', async () => {
    const daemon = fakeDaemon(succeeds);
    const { promise } = run(stubCli('unauthorized: authentication required'), daemon);
    const err = await promise.catch((e) => e);
    expect(err.message).toBe(`The registry refused access to ${IMAGE}: unauthorized: authentication required`);
    expect(createErrorReport({ step: 'Containers', message: err.message }).hintId).toBe('registry-denied');
    expect(daemon.calls).toHaveLength(0);
  });

  it('shows real bytes against the manifest size', async () => {
    const daemon = fakeDaemon(succeeds);
    const { promise, events } = run(stubCli(), daemon);
    await promise;
    const labels = events.flatMap((e) => (e.type === 'progress' ? [e.label] : []));
    expect(labels).toContain('Downloading the dev container: 50 MB of 100 MB');
    expect(logs(events)).toContain('The dev container is 100 MB in 1 layers.');
    expect(logs(events)).toContain('Downloaded 100 MB.');
    // The bundled login goes to the daemon.
    expect(daemon.calls[0].headers['X-Registry-Auth']).toBeTruthy();
  });

  it('does not retry a silent stall, which would restart any unpacking from scratch', async () => {
    const daemon = fakeDaemon(hangs, succeeds);
    const err = await run(stubCli(), daemon).promise.catch((e) => e);
    expect(daemon.calls).toHaveLength(1);
    expect(err).toBeInstanceOf(PullStalledError);
    expect(err.phase).toBe('start');
    expect(createErrorReport({ step: 'Containers', message: err.message }).hintId).toBe('pull-stalled');
  });

  it('retries a download whose bytes stop, then succeeds', async () => {
    const daemon = fakeDaemon(bytesStop, succeeds);
    const { promise, events } = run(stubCli(), daemon);
    await promise;
    expect(daemon.calls).toHaveLength(2);
    expect(logs(events).some((m) => /download stalled.*Trying again \(2 of 2\)/.test(m))).toBe(true);
  });

  it('fails with the stall hint once retries run out', async () => {
    const daemon = fakeDaemon(bytesStop);
    const err = await run(stubCli(), daemon).promise.catch((e) => e);
    expect(daemon.calls).toHaveLength(2);
    expect(err).toBeInstanceOf(PullStalledError);
    expect(err.phase).toBe('download');
    expect(createErrorReport({ step: 'Containers', message: err.message }).hintId).toBe('pull-stalled');
  });
});
