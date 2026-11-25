import fs from 'node:fs';
import path from 'node:path';
import { discardDownload, downloadCachePath, downloadFile } from './downloader';
import { execElevatedPowerShell, execPrivileged, execPrivilegedScript } from './elevation';
import { toErrorReport } from './errors';
import { downloadReporting, logEvent, networkReporter } from './events';
import { execCommand } from './exec';
import { commandExists, createTempDir, getArch, getOsRelease, getTargetOS, getTargetUser, quotePs, quoteSh, removeDirSafe } from './platform';
import type { DockerKind, InstallEvent, TargetOS } from '../../shared/types';

const NOTE_MARKER = '@@NOTE ';

/** A finished installer download younger than this is reused on Retry instead of fetched again. */
const REUSE_DOWNLOAD_MS = 24 * 60 * 60 * 1000;

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

/** curl options for flaky connections: retry dropped and refused connections, don't hang on connect. */
export const CURL_RETRY = '--retry 5 --retry-delay 3 --retry-connrefused --connect-timeout 20';
/** apt options for flaky connections. */
export const APT_RETRY = '-o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30';

/** Root script that adds Docker's apt repo and installs the Docker Desktop .deb. */
export function buildDebianDesktopScript(distro: 'debian' | 'ubuntu', debPath: string): string {
  return [
    `apt-get ${APT_RETRY} update`,
    `apt-get ${APT_RETRY} install -y ca-certificates curl`,
    'install -m 0755 -d /etc/apt/keyrings',
    `curl -fsSL ${CURL_RETRY} https://download.docker.com/linux/${distro}/gpg -o /etc/apt/keyrings/docker.asc`,
    'chmod a+r /etc/apt/keyrings/docker.asc',
    '. /etc/os-release',
    `echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${distro} \${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list`,
    `apt-get ${APT_RETRY} update`,
    // Let apt's sandbox user read the downloaded package.
    `chmod a+rx ${quoteSh(path.dirname(debPath))}`,
    `chmod a+r ${quoteSh(debPath)}`,
    `apt-get ${APT_RETRY} install -y ${quoteSh(debPath)}`,
  ].join('\n');
}

/** Root script that adds Docker's dnf repo and installs the downloaded Docker Desktop .rpm. */
export function buildFedoraDesktopScript(rpmPath: string): string {
  return [
    `curl -fsSL ${CURL_RETRY} https://download.docker.com/linux/fedora/docker-ce.repo -o /etc/yum.repos.d/docker-ce.repo`,
    // Let dnf read the package from the user's download folder.
    `chmod a+rx ${quoteSh(path.dirname(rpmPath))}`,
    `chmod a+r ${quoteSh(rpmPath)}`,
    `dnf install -y --setopt=retries=5 --setopt=timeout=30 ${quoteSh(rpmPath)}`,
  ].join('\n');
}

/** Docker Desktop's official Windows installer. */
export function dockerDesktopInstallerUrl(arch: string): string {
  return `https://desktop.docker.com/win/main/${arch}/Docker%20Desktop%20Installer.exe`;
}

/**
 * Elevated PowerShell body for Windows: WSL2, Docker Desktop and docker-users membership.
 *
 * The installer is downloaded beforehand, without elevation, by downloadFile (progress, resume,
 * proxy). The script copies it into the admin-only Windows temp folder first and checks the
 * signature of that copy, so nothing running as the user can swap the file after the check.
 */
export function buildWindowsDockerScript(opts: { installWsl: boolean; installerPath: string; targetUser: string }): string {
  return [
    `$dockerExe = Join-Path $env:ProgramFiles 'Docker\\Docker\\Docker Desktop.exe'`,
    opts.installWsl
      ? [
          "'WSL2 not detected; installing it (no Linux distribution)'",
          "Invoke-Checked 'wsl.exe' @('--install', '--no-distribution')",
          `'${NOTE_MARKER}Reboot Windows to finish the WSL2 install before starting Docker Desktop.'`,
        ].join('\n')
      : '',
    "if (-not (Test-Path $dockerExe)) {",
    "  $installer = Join-Path $env:SystemRoot ('Temp\\DockerDesktopInstaller-' + [guid]::NewGuid().ToString('N') + '.exe')",
    `  Copy-Item -LiteralPath ${quotePs(opts.installerPath)} -Destination $installer -Force -ErrorAction Stop`,
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
  const log = (level: 'info' | 'warn', message: string, output = false) => options.emit(logEvent(message, level, output));
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
    // Download first, unelevated: progress, resume after a drop, and the system proxy.
    const url = dockerDesktopInstallerUrl(await getArch(targetOS));
    const installer = downloadCachePath(url, 'Docker Desktop Installer.exe');
    await downloadFile(url, installer, {
      signal: options.signal,
      reuseForMs: REUSE_DOWNLOAD_MS,
      ...downloadReporting(options.emit, 'Docker', 'the Docker Desktop installer'),
    });
    await execElevatedPowerShell(buildWindowsDockerScript({ installWsl: !wslReady, installerPath: installer, targetUser: getTargetUser() }), exec);
    discardDownload(installer);
    if ((await detectDocker(targetOS)) === 'none') throw new Error('Docker installation finished but Docker Desktop was not found.');
    return 'installed';
  }

  if (targetOS === 'macos') {
    const arch = await getArch(targetOS);
    const url = `https://desktop.docker.com/mac/main/${arch}/Docker.dmg`;
    const dmg = downloadCachePath(url, 'Docker.dmg');
    await downloadFile(url, dmg, { signal: options.signal, reuseForMs: REUSE_DOWNLOAD_MS, ...downloadReporting(options.emit, 'Docker', 'Docker.dmg') });
    const tmp = createTempDir();
    const mount = path.join(tmp, 'mnt');
    let attached = false;
    try {
      fs.mkdirSync(mount, { recursive: true });
      await execCommand('hdiutil', ['attach', dmg, '-nobrowse', '-quiet', '-mountpoint', mount], exec);
      attached = true;
      const installer = path.join(mount, 'Docker.app/Contents/MacOS/install');
      await execCommand('codesign', ['--verify', '--deep', path.join(mount, 'Docker.app')], exec);
      log('info', 'Docker Desktop needs administrator rights; enter your password in the macOS prompt.');
      await execPrivileged(installer, ['--accept-license', `--user=${getTargetUser()}`], exec);
      discardDownload(dmg);
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
      await downloadFile('https://get.docker.com', scriptPath, {
        signal: options.signal,
        onNetwork: networkReporter(options.emit, 'Docker', 'downloading the Docker install script'),
      });
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
      const url = 'https://desktop.docker.com/linux/main/amd64/docker-desktop-amd64.deb';
      const deb = downloadCachePath(url, 'docker-desktop-amd64.deb');
      await downloadFile(url, deb, { signal: options.signal, reuseForMs: REUSE_DOWNLOAD_MS, ...downloadReporting(options.emit, 'Docker', 'Docker Desktop') });
      await execPrivilegedScript(buildDebianDesktopScript(distro, deb), exec);
      discardDownload(deb);
    } else {
      const url = 'https://desktop.docker.com/linux/main/amd64/docker-desktop-x86_64.rpm';
      const rpm = downloadCachePath(url, 'docker-desktop-x86_64.rpm');
      await downloadFile(url, rpm, { signal: options.signal, reuseForMs: REUSE_DOWNLOAD_MS, ...downloadReporting(options.emit, 'Docker', 'Docker Desktop') });
      await execPrivilegedScript(buildFedoraDesktopScript(rpm), exec);
      discardDownload(rpm);
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
