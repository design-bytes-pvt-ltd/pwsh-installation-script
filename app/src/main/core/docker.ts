import fs from 'node:fs';
import path from 'node:path';
import { downloadFile } from './downloader';
import {
  commandExists,
  createTempDir,
  execCommand,
  execPrivileged,
  getArch,
  getOsRelease,
  getTargetOS,
  getTargetUser,
  removeDirSafe,
} from './platform';
import { DockerKind, InstallEvent, TargetOS } from './types';

export async function detectDocker(targetOS: TargetOS = getTargetOS()): Promise<DockerKind> {
  if (targetOS === 'windows') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    return fs.existsSync(path.join(pf, 'Docker', 'Docker', 'Docker Desktop.exe')) ? 'desktop' : 'none';
  }
  if (targetOS === 'macos') {
    return fs.existsSync('/Applications/Docker.app') ? 'desktop' : 'none';
  }
  if (fs.existsSync('/opt/docker-desktop/bin/docker-desktop') || fs.existsSync('/opt/docker-desktop')) {
    return 'desktop';
  }
  return (await commandExists('docker', targetOS)) ? 'engine' : 'none';
}

export async function installDocker(options: {
  dockerEngineOnLinux?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
  emit: (event: InstallEvent) => void;
}): Promise<string> {
  const targetOS = getTargetOS();
  const existing = await detectDocker(targetOS);
  if (existing !== 'none') {
    options.emit({ type: 'log', level: 'info', message: `Docker already installed (${existing})`, timestamp: new Date().toISOString() });
    return 'already present';
  }
  if (options.dryRun) {
    options.emit({ type: 'log', level: 'info', message: `[dry-run] Would install Docker on ${targetOS}`, timestamp: new Date().toISOString() });
    return 'would install';
  }

  const onOutput = (line: string) =>
    options.emit({ type: 'log', level: 'info', message: line, timestamp: new Date().toISOString() });
  const addNote = (message: string) => options.emit({ type: 'note', message });

  if (targetOS === 'windows') {
    const wsl = await commandExists('wsl.exe', targetOS);
    let wslReady = false;
    if (wsl) {
      try {
        await execCommand(wsl, ['--status'], { signal: options.signal });
        wslReady = true;
      } catch {
        wslReady = false;
      }
    }
    if (!wslReady && wsl) {
      await execCommand(wsl, ['--install', '--no-distribution'], { signal: options.signal, onOutput });
      addNote('Reboot Windows to finish the WSL2 install before starting Docker Desktop.');
    }

    const winget = await commandExists('winget', targetOS);
    let installedViaWinget = false;
    if (winget) {
      try {
        await execCommand(
          winget,
          ['install', '-e', '--id', 'Docker.DockerDesktop', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'],
          { signal: options.signal, onOutput }
        );
        installedViaWinget = true;
      } catch {
        // Fallback to direct installer
      }
    }

    if (!installedViaWinget || (await detectDocker(targetOS)) === 'none') {
      const arch = await getArch(targetOS);
      const tmp = createTempDir();
      try {
        const exe = path.join(tmp, 'DockerDesktopInstaller.exe');
        await downloadFile(`https://desktop.docker.com/win/main/${arch}/Docker%20Desktop%20Installer.exe`, exe, {
          signal: options.signal,
          onProgress: (p) =>
            options.emit({ type: 'progress', step: 'Docker', label: 'Downloading Docker Desktop', completed: p.completed, total: p.total ?? undefined, percent: p.percent ?? undefined }),
        });
        await execCommand(exe, ['install', '--quiet', '--accept-license', '--backend=wsl-2'], { signal: options.signal, onOutput });
      } finally {
        removeDirSafe(tmp);
      }
    }

    const targetUser = getTargetUser();
    if (targetUser) {
      await execCommand('net', ['localgroup', 'docker-users', targetUser, '/add'], { allowedExitCodes: [0, 2], onOutput });
    }
    addNote('Sign out and back in (or reboot) so the docker-users group membership takes effect, then start Docker Desktop.');
    return 'installed';
  }

  if (targetOS === 'macos') {
    const arch = await getArch(targetOS);
    const tmp = createTempDir();
    const mount = path.join(tmp, 'mnt');
    let attached = false;
    try {
      const dmg = path.join(tmp, 'Docker.dmg');
      await downloadFile(`https://desktop.docker.com/mac/main/${arch}/Docker.dmg`, dmg, {
        signal: options.signal,
        onProgress: (p) =>
          options.emit({ type: 'progress', step: 'Docker', label: 'Downloading Docker.dmg', completed: p.completed, total: p.total ?? undefined, percent: p.percent ?? undefined }),
      });
      fs.mkdirSync(mount, { recursive: true });
      await execCommand('hdiutil', ['attach', dmg, '-nobrowse', '-quiet', '-mountpoint', mount], { signal: options.signal, onOutput });
      attached = true;
      const targetUser = getTargetUser();
      await execPrivileged(path.join(mount, 'Docker.app/Contents/MacOS/install'), ['--accept-license', `--user=${targetUser}`], { signal: options.signal, onOutput });
    } finally {
      if (attached) {
        try { await execCommand('hdiutil', ['detach', mount, '-quiet']); } catch { /* ignore */ }
      }
      removeDirSafe(tmp);
    }
    addNote('Open Docker Desktop once (/Applications/Docker.app) to finish setup.');
    return 'installed';
  }

  // Linux
  const osInfo = getOsRelease();
  const id = osInfo.ID ?? '';
  const like = osInfo.ID_LIKE ?? '';
  const arch = await getArch(targetOS);
  const hasKvm = fs.existsSync('/dev/kvm');
  const hasGui = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

  let fallbackReason: string | null = null;
  if (options.dockerEngineOnLinux) fallbackReason = 'Docker Engine selected';
  else if (arch !== 'amd64') fallbackReason = 'Docker Desktop for Linux requires x86_64';
  else if (!hasKvm) fallbackReason = 'KVM (/dev/kvm) is not available';
  else if (!hasGui) fallbackReason = 'No graphical session detected';

  const family = /ubuntu|debian/.test(`${id} ${like}`) ? 'debian' : id === 'fedora' ? 'fedora' : null;
  if (!fallbackReason && !family) fallbackReason = `Docker Desktop is not supported on '${id}'`;

  const installEngine = async (): Promise<void> => {
    const tmp = createTempDir();
    try {
      const scriptPath = path.join(tmp, 'get-docker.sh');
      await downloadFile('https://get.docker.com', scriptPath, { signal: options.signal });
      await execPrivileged('sh', [scriptPath], { signal: options.signal, onOutput });
    } finally {
      removeDirSafe(tmp);
    }
    if (await commandExists('systemctl', targetOS)) {
      try { await execPrivileged('systemctl', ['enable', '--now', 'docker'], { signal: options.signal, onOutput }); } catch { /* ignore */ }
    }
    const targetUser = getTargetUser();
    if (targetUser && targetUser !== 'root') {
      await execPrivileged('usermod', ['-aG', 'docker', targetUser], { signal: options.signal, onOutput });
      addNote(`Log out and back in so '${targetUser}' can run docker without sudo.`);
    }
  };

  if (fallbackReason) {
    options.emit({ type: 'log', level: 'info', message: `Using Docker Engine: ${fallbackReason}`, timestamp: new Date().toISOString() });
    await installEngine();
    return 'installed (Engine)';
  }

  try {
    if (family === 'debian') {
      const distro = id === 'debian' ? 'debian' : 'ubuntu';
      const tmp = createTempDir();
      try {
        const repoScript = path.join(tmp, 'setup-repo.sh');
        fs.writeFileSync(
          repoScript,
          [
            'set -e',
            'apt-get update',
            'apt-get install -y ca-certificates curl',
            'install -m 0755 -d /etc/apt/keyrings',
            `curl -fsSL https://download.docker.com/linux/${distro}/gpg -o /etc/apt/keyrings/docker.asc`,
            'chmod a+r /etc/apt/keyrings/docker.asc',
            '. /etc/os-release',
            `echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${distro} \${UBUNTU_CODENAME:-\$VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list`,
            'apt-get update',
          ].join('\n')
        );
        await execPrivileged('sh', [repoScript], { signal: options.signal, onOutput });
        const deb = path.join(tmp, 'docker-desktop-amd64.deb');
        await downloadFile('https://desktop.docker.com/linux/main/amd64/docker-desktop-amd64.deb', deb, { signal: options.signal });
        await execPrivileged('apt-get', ['install', '-y', deb], { signal: options.signal, onOutput });
      } finally {
        removeDirSafe(tmp);
      }
    } else {
      await execPrivileged('curl', ['-fsSL', 'https://download.docker.com/linux/fedora/docker-ce.repo', '-o', '/etc/yum.repos.d/docker-ce.repo'], { signal: options.signal, onOutput });
      await execPrivileged('dnf', ['install', '-y', 'https://desktop.docker.com/linux/main/amd64/docker-desktop-x86_64.rpm'], { signal: options.signal, onOutput });
    }
    addNote('Start Docker Desktop from your applications menu (or: systemctl --user start docker-desktop).');
    return 'installed (Desktop)';
  } catch {
    options.emit({ type: 'log', level: 'warn', message: 'Docker Desktop install failed; falling back to Docker Engine.', timestamp: new Date().toISOString() });
    await installEngine();
    return 'installed (Engine fallback)';
  }
}
