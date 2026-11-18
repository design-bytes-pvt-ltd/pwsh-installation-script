import fs from 'node:fs';
import path from 'node:path';
import { downloadFile } from './downloader';
import {
  commandExists,
  createTempDir,
  execCommand,
  execElevatedPowerShell,
  execPrivileged,
  execPrivilegedScript,
  getArch,
  getOsRelease,
  getTargetOS,
  getTargetUser,
  quotePs,
  quoteSh,
  removeDirSafe,
} from './platform';
import { toErrorReport } from './errors';
import { DockerKind, InstallEvent, TargetOS } from './types';

const NOTE_MARKER = '@@NOTE ';

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

/** Root script for Docker Engine via get.docker.com. Group/service failures only add notes. */
export function buildEngineScript(getDockerPath: string, targetUser: string): string {
  const lines = [`sh ${quoteSh(getDockerPath)}`];
  lines.push(
    'if command -v systemctl >/dev/null 2>&1; then',
    `  systemctl enable --now docker || echo ${quoteSh(`${NOTE_MARKER}Could not enable the docker service; start it with: sudo systemctl enable --now docker`)}`,
    'fi'
  );
  if (targetUser && targetUser !== 'root') {
    lines.push(
      `if usermod -aG docker ${quoteSh(targetUser)}; then`,
      `  echo ${quoteSh(`${NOTE_MARKER}Log out and back in so '${targetUser}' can run docker without sudo.`)}`,
      'else',
      `  echo ${quoteSh(`${NOTE_MARKER}Could not add '${targetUser}' to the docker group; run: sudo usermod -aG docker ${targetUser}`)}`,
      'fi'
    );
  }
  return lines.join('\n');
}

/** Root script that adds Docker's apt repo and installs the Docker Desktop .deb. */
export function buildDebianDesktopScript(distro: 'debian' | 'ubuntu', debPath: string): string {
  return [
    'apt-get update',
    'apt-get install -y ca-certificates curl',
    'install -m 0755 -d /etc/apt/keyrings',
    `curl -fsSL https://download.docker.com/linux/${distro}/gpg -o /etc/apt/keyrings/docker.asc`,
    'chmod a+r /etc/apt/keyrings/docker.asc',
    '. /etc/os-release',
    `echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${distro} \${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list`,
    'apt-get update',
    // Let apt's sandbox user read the downloaded package.
    `chmod a+rx ${quoteSh(path.dirname(debPath))}`,
    `chmod a+r ${quoteSh(debPath)}`,
    `apt-get install -y ${quoteSh(debPath)}`,
  ].join('\n');
}

/** Elevated PowerShell body for Windows: WSL2, Docker Desktop and docker-users membership. */
export function buildWindowsDockerScript(opts: { installWsl: boolean; arch: string; targetUser: string }): string {
  const url = `https://desktop.docker.com/win/main/${opts.arch}/Docker%20Desktop%20Installer.exe`;
  return [
    `$dockerExe = Join-Path $env:ProgramFiles 'Docker\\Docker\\Docker Desktop.exe'`,
    opts.installWsl
      ? [
          "'WSL2 not detected; installing it (no Linux distribution)'",
          "Invoke-Checked 'wsl.exe' @('--install', '--no-distribution')",
          `'${NOTE_MARKER}Reboot Windows to finish the WSL2 install before starting Docker Desktop.'`,
        ].join('\n')
      : '',
    "if (Get-Command winget -ErrorAction SilentlyContinue) {",
    "  try {",
    "    Invoke-Checked 'winget' @('install', '-e', '--id', 'Docker.DockerDesktop', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')",
    "  } catch { \"winget install failed: $($_.Exception.Message); using the official installer\" }",
    "}",
    "if (-not (Test-Path $dockerExe)) {",
    "  $installer = Join-Path ([IO.Path]::GetTempPath()) ('DockerDesktopInstaller-' + [guid]::NewGuid().ToString('N') + '.exe')",
    `  "Downloading ${url}"`,
    `  Invoke-WebRequest -Uri ${quotePs(url)} -OutFile $installer -UseBasicParsing -ErrorAction Stop`,
    "  try {",
    "    $sig = Get-AuthenticodeSignature -FilePath $installer",
    "    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Docker') {",
    "      throw \"Docker Desktop installer signature check failed ($($sig.Status), $($sig.SignerCertificate.Subject))\"",
    "    }",
    "    Invoke-Checked $installer @('install', '--quiet', '--accept-license', '--backend=wsl-2')",
    "  } finally { Remove-Item $installer -Force -ErrorAction SilentlyContinue }",
    "}",
    "if (-not (Test-Path $dockerExe)) { throw 'Docker Desktop installation finished but Docker Desktop.exe was not found.' }",
    // Add-LocalGroupMember reports "already a member" distinctly, unlike net.exe (exit 2 for everything).
    `$user = ${quotePs(opts.targetUser)}`,
    "try {",
    "  Add-LocalGroupMember -Group 'docker-users' -Member $user -ErrorAction Stop",
    "  \"Added $user to docker-users\"",
    `  '${NOTE_MARKER}Sign out and back in (or reboot) so the docker-users group membership takes effect, then start Docker Desktop.'`,
    "} catch {",
    "  if ($_.FullyQualifiedErrorId -like 'MemberExists*') { \"$user is already in docker-users\" }",
    `  else { "${NOTE_MARKER}Could not add $user to the docker-users group ($($_.Exception.Message)). Ask an administrator to add you." }`,
    "}",
  ]
    .filter(Boolean)
    .join('\n');
}

export async function installDocker(options: {
  dockerEngineOnLinux?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
  emit: (event: InstallEvent) => void;
}): Promise<string> {
  const targetOS = getTargetOS();
  const existing = await detectDocker(targetOS);
  const log = (level: 'info' | 'warn', message: string, output = false) =>
    options.emit({ type: 'log', level, message, timestamp: new Date().toISOString(), output });
  if (existing !== 'none') {
    log('info', `Docker already installed (${existing})`);
    return 'already present';
  }
  if (options.dryRun) {
    log('info', `[dry-run] Would install Docker on ${targetOS}`);
    return 'would install';
  }

  const addNote = (message: string) => options.emit({ type: 'note', message });
  // Elevated scripts report follow-up steps as "@@NOTE ..." lines.
  const onOutput = (line: string) => {
    const at = line.indexOf(NOTE_MARKER);
    if (at >= 0) addNote(line.slice(at + NOTE_MARKER.length).trim());
    else log('info', line, true);
  };
  const exec = { signal: options.signal, onOutput };

  if (targetOS === 'windows') {
    let wslReady = false;
    const wsl = await commandExists('wsl.exe', targetOS);
    if (wsl) {
      try {
        await execCommand(wsl, ['--status'], { signal: options.signal, env: { ...process.env, WSL_UTF8: '1' } });
        wslReady = true;
      } catch {
        wslReady = false;
      }
    }
    log('info', 'Docker Desktop needs administrator rights; approve the Windows prompt to continue.');
    await execElevatedPowerShell(
      buildWindowsDockerScript({ installWsl: !wslReady, arch: await getArch(targetOS), targetUser: getTargetUser() }),
      exec
    );
    if ((await detectDocker(targetOS)) === 'none') throw new Error('Docker installation finished but Docker Desktop was not found.');
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
      await execCommand('hdiutil', ['attach', dmg, '-nobrowse', '-quiet', '-mountpoint', mount], exec);
      attached = true;
      const installer = path.join(mount, 'Docker.app/Contents/MacOS/install');
      await execCommand('codesign', ['--verify', '--deep', path.join(mount, 'Docker.app')], exec);
      log('info', 'Docker Desktop needs administrator rights; enter your password in the macOS prompt.');
      await execPrivileged(installer, ['--accept-license', `--user=${getTargetUser()}`], exec);
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
      await execPrivilegedScript(buildEngineScript(scriptPath, getTargetUser()), exec);
    } finally {
      removeDirSafe(tmp);
    }
  };

  if (fallbackReason) {
    log('info', `Using Docker Engine: ${fallbackReason}`);
    await installEngine();
    return 'installed (Engine)';
  }

  try {
    if (family === 'debian') {
      const distro = id === 'debian' ? 'debian' : 'ubuntu';
      const tmp = createTempDir();
      try {
        const deb = path.join(tmp, 'docker-desktop-amd64.deb');
        await downloadFile('https://desktop.docker.com/linux/main/amd64/docker-desktop-amd64.deb', deb, {
          signal: options.signal,
          onProgress: (p) =>
            options.emit({ type: 'progress', step: 'Docker', label: 'Downloading Docker Desktop', completed: p.completed, total: p.total ?? undefined, percent: p.percent ?? undefined }),
        });
        await execPrivilegedScript(buildDebianDesktopScript(distro, deb), exec);
      } finally {
        removeDirSafe(tmp);
      }
    } else {
      await execPrivilegedScript(
        [
          'curl -fsSL https://download.docker.com/linux/fedora/docker-ce.repo -o /etc/yum.repos.d/docker-ce.repo',
          'dnf install -y https://desktop.docker.com/linux/main/amd64/docker-desktop-x86_64.rpm',
        ].join('\n'),
        exec
      );
    }
    addNote('Start Docker Desktop from your applications menu (or: systemctl --user start docker-desktop).');
    return 'installed (Desktop)';
  } catch (err) {
    if (options.signal?.aborted) throw err;
    const r = toErrorReport(err, 'Docker');
    log(
      'warn',
      ['Docker Desktop install failed; falling back to Docker Engine.', `What failed: ${r.summary}`, r.command && `Command: ${r.command}`, r.hint && `Hint: ${r.hint}`]
        .filter(Boolean)
        .join('\n')
    );
    await installEngine();
    return 'installed (Engine fallback)';
  }
}
