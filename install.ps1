<#
.SYNOPSIS
    Installs Ollama, pulls Ollama models and installs Docker Desktop on Windows, macOS or Linux.

.DESCRIPTION
    Runs unattended end-to-end. Each step is idempotent: tools that are already installed are
    detected and skipped. Use -WhatIf for a dry run that only prints what would be done.

    Windows : winget (falls back to the official installers). Re-launches itself elevated.
    macOS   : official Ollama zip and Docker Desktop DMG (prompts once for sudo for Docker).
    Linux   : official Ollama install script. Docker Desktop on Ubuntu/Debian/Fedora (x86_64,
              KVM and a graphical session required), otherwise Docker Engine via get.docker.com.

.PARAMETER Models
    Ollama models to pull. Accepts an array or a comma-separated string. Default: qwen3:0.6b

.PARAMETER SkipOllama
    Do not install Ollama.

.PARAMETER SkipModels
    Do not pull any models.

.PARAMETER SkipDocker
    Do not install Docker.

.PARAMETER DockerEngine
    Linux only: install Docker Engine instead of Docker Desktop.

.EXAMPLE
    ./install.ps1

.EXAMPLE
    ./install.ps1 -Models qwen3:0.6b,llama3.2 -SkipDocker

.EXAMPLE
    ./install.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string[]]$Models = @('qwen3:0.6b'),
    [switch]$SkipOllama,
    [switch]$SkipModels,
    [switch]$SkipDocker,
    [switch]$DockerEngine
)

$ErrorActionPreference = 'Stop'
$script:Ctx = $PSCmdlet

# --------------------------------------------------------------------------------------------
# Platform detection (Windows PowerShell 5.1 has no $IsWindows/$IsMacOS/$IsLinux)
# --------------------------------------------------------------------------------------------
$script:OnWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or ($IsWindows -eq $true)
$script:OnMac     = (-not $script:OnWindows) -and ($IsMacOS -eq $true)
$script:OnLinux   = (-not $script:OnWindows) -and ($IsLinux -eq $true)

$script:Results = [ordered]@{}
$script:Notes   = New-Object System.Collections.Generic.List[string]

# Allow "-Models a,b" passed as a single string (e.g. through -File or the elevated relaunch).
$Models = @($Models | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

# --------------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------------
function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message)   { Write-Host "    [ok] $Message" -ForegroundColor Green }
function Write-Info([string]$Message) { Write-Host "    $Message" }
function Write-Warn([string]$Message) { Write-Host "    [warn] $Message" -ForegroundColor Yellow }

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Confirm-Action([string]$Target, [string]$Action) {
    return $script:Ctx.ShouldProcess($Target, $Action)
}

function Get-Arch {
    if ($script:OnWindows) {
        $a = $env:PROCESSOR_ARCHITEW6432
        if (-not $a) { $a = $env:PROCESSOR_ARCHITECTURE }
    } elseif ($script:OnMac -and ((& sysctl -in hw.optional.arm64) -eq '1')) {
        $a = 'arm64'   # correct even when pwsh runs under Rosetta
    } else {
        $a = (& uname -m).Trim()
    }
    switch -Regex ($a) {
        '^(AMD64|x86_64)$'   { return 'amd64' }
        '^(ARM64|aarch64|arm64)$' { return 'arm64' }
        default { throw "Unsupported CPU architecture: $a" }
    }
}

function Test-IsRoot {
    if ($script:OnWindows) { return $false }
    return ((& id -u).Trim() -eq '0')
}

function Invoke-Native {
    # Runs an external command and throws if it exits non-zero.
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [int[]]$AllowedExitCodes = @(0)
    )
    $display = (@($FilePath) + $ArgumentList) -join ' '
    if (-not (Confirm-Action $display 'Run')) { return }
    # Out-Host keeps command output on screen instead of leaking into function return values.
    & $FilePath @ArgumentList | Out-Host
    if ($AllowedExitCodes -notcontains $LASTEXITCODE) {
        throw "Command failed (exit code $LASTEXITCODE): $display"
    }
}

function Invoke-Sudo {
    # Runs a command as root on macOS/Linux (directly if already root).
    param([Parameter(Mandatory)][string]$FilePath, [string[]]$ArgumentList = @())
    if (Test-IsRoot) {
        Invoke-Native -FilePath $FilePath -ArgumentList $ArgumentList
    } else {
        Invoke-Native -FilePath 'sudo' -ArgumentList (@($FilePath) + $ArgumentList)
    }
}

function New-TempDir {
    $path = Join-Path ([System.IO.Path]::GetTempPath()) ("docker-ollama-" + [guid]::NewGuid().ToString('N'))
    [void][System.IO.Directory]::CreateDirectory($path)
    return $path
}

function Invoke-Download([string]$Url, [string]$Destination) {
    if (-not (Confirm-Action $Url "Download to $Destination")) { return }
    Write-Info "Downloading $Url"
    $oldProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'   # progress bar makes IWR very slow on 5.1
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
    } finally {
        $ProgressPreference = $oldProgress
    }
}

function Update-SessionPath {
    if (-not $script:OnWindows) { return }
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Install-WithWinget([string]$Id) {
    if (-not (Test-Command 'winget')) { return $false }
    try {
        Invoke-Native -FilePath 'winget' -ArgumentList @(
            'install', '-e', '--id', $Id, '--silent',
            '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
        return $true
    } catch {
        Write-Warn "winget install of $Id failed: $($_.Exception.Message)"
        return $false
    }
}

# --------------------------------------------------------------------------------------------
# Ollama
# --------------------------------------------------------------------------------------------
function Get-OllamaExe {
    $cmd = Get-Command ollama -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @()
    if ($script:OnWindows) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe') }
    if ($script:OnMac)     { $candidates += '/Applications/Ollama.app/Contents/Resources/ollama' }
    if ($script:OnLinux)   { $candidates += @('/usr/local/bin/ollama', '/usr/bin/ollama') }
    foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
    return $null
}

function Install-Ollama {
    Write-Step 'Ollama'
    if (Get-OllamaExe) {
        Write-Ok "Already installed: $(Get-OllamaExe)"
        return 'already present'
    }

    if ($script:OnWindows) {
        $ok = Install-WithWinget 'Ollama.Ollama'
        Update-SessionPath
        if (-not $ok -or -not (Get-OllamaExe)) {
            $tmp = New-TempDir
            try {
                $exe = Join-Path $tmp 'OllamaSetup.exe'
                Invoke-Download 'https://ollama.com/download/OllamaSetup.exe' $exe
                if (Confirm-Action $exe 'Run Ollama installer silently') {
                    $p = Start-Process -FilePath $exe -ArgumentList '/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES' -Wait -PassThru
                    if ($p.ExitCode -ne 0) { throw "Ollama installer exited with code $($p.ExitCode)" }
                }
            } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue -WhatIf:$false }
            Update-SessionPath
        }
    }
    elseif ($script:OnMac) {
        $tmp = New-TempDir
        try {
            $zip = Join-Path $tmp 'Ollama-darwin.zip'
            Invoke-Download 'https://ollama.com/download/Ollama-darwin.zip' $zip
            try {
                Invoke-Native -FilePath 'ditto' -ArgumentList @('-x', '-k', $zip, '/Applications')
            } catch {
                Write-Warn '/Applications not writable, retrying with sudo'
                Invoke-Sudo -FilePath 'ditto' -ArgumentList @('-x', '-k', $zip, '/Applications')
            }
            Invoke-Native -FilePath 'open' -ArgumentList @('-a', '/Applications/Ollama.app')
        } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue -WhatIf:$false }
    }
    elseif ($script:OnLinux) {
        if (-not (Test-Command 'curl')) { throw 'curl is required to install Ollama on Linux.' }
        # The official script uses sudo itself when needed and sets up the systemd service.
        Invoke-Native -FilePath 'sh' -ArgumentList @('-c', 'curl -fsSL https://ollama.com/install.sh | sh')
    }

    if ($WhatIfPreference) { return 'would install' }
    if (-not (Get-OllamaExe)) { throw 'Ollama installation finished but the ollama binary was not found.' }
    Write-Ok "Installed: $(Get-OllamaExe)"
    return 'installed'
}

function Test-OllamaServer {
    try {
        $null = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 -UseBasicParsing
        return $true
    } catch { return $false }
}

function Wait-OllamaServer([string]$OllamaExe) {
    if (Test-OllamaServer) { return }

    Write-Info 'Waiting for the Ollama server to start...'
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        if (Test-OllamaServer) { return }
    }

    Write-Info "Starting 'ollama serve' in the background"
    $log = Join-Path ([System.IO.Path]::GetTempPath()) 'ollama-serve.log'
    $startArgs = @{
        FilePath               = $OllamaExe
        ArgumentList           = 'serve'
        RedirectStandardOutput = $log
        RedirectStandardError  = "$log.err"
    }
    if ($script:OnWindows) { $startArgs.WindowStyle = 'Hidden' }
    $null = Start-Process @startArgs

    for ($i = 0; $i -lt 45; $i++) {
        Start-Sleep -Seconds 1
        if (Test-OllamaServer) { return }
    }
    throw "Ollama server did not become reachable on http://127.0.0.1:11434 (see $log.err)."
}

function Invoke-ModelPull {
    Write-Step "Ollama models: $($Models -join ', ')"
    if ($Models.Count -eq 0) { Write-Info 'No models requested.'; return 'skipped' }

    $ollama = Get-OllamaExe
    if (-not $ollama) {
        if ($WhatIfPreference) {
            foreach ($m in $Models) { [void](Confirm-Action "ollama pull $m" 'Run') }
            return 'would pull'
        }
        throw 'Ollama is not installed; cannot pull models.'
    }

    if (-not $WhatIfPreference) { Wait-OllamaServer $ollama }

    $failed = @()
    foreach ($m in $Models) {
        try {
            Invoke-Native -FilePath $ollama -ArgumentList @('pull', $m)
            if (-not $WhatIfPreference) { Write-Ok "Pulled $m" }
        } catch {
            Write-Warn "Failed to pull ${m}: $($_.Exception.Message)"
            $failed += $m
        }
    }
    if ($WhatIfPreference) { return 'would pull' }
    if ($failed.Count -gt 0) { throw "Failed to pull: $($failed -join ', ')" }
    return 'pulled'
}

# --------------------------------------------------------------------------------------------
# Docker
# --------------------------------------------------------------------------------------------
function Test-DockerInstalled {
    if ($script:OnWindows) {
        return (Test-Path (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'))
    }
    if ($script:OnMac) { return (Test-Path '/Applications/Docker.app') }
    return (Test-Command 'docker') -or (Test-Path '/opt/docker-desktop')
}

function Install-DockerWindows {
    # WSL2 is required by the default Docker Desktop backend.
    $wslReady = $false
    if (Test-Command 'wsl.exe') {
        $oldEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'   # 5.1 turns redirected native stderr into errors
        try { & wsl.exe --status *> $null; $wslReady = ($LASTEXITCODE -eq 0) }
        catch { $wslReady = $false }
        finally { $ErrorActionPreference = $oldEap }
    }
    if (-not $wslReady) {
        Write-Info 'WSL2 not detected; installing it (no Linux distribution)'
        Invoke-Native -FilePath 'wsl.exe' -ArgumentList @('--install', '--no-distribution')
        $script:Notes.Add('Reboot Windows to finish the WSL2 install before starting Docker Desktop.')
    }

    $ok = Install-WithWinget 'Docker.DockerDesktop'
    if (-not $ok -or (-not $WhatIfPreference -and -not (Test-DockerInstalled))) {
        $tmp = New-TempDir
        try {
            $exe = Join-Path $tmp 'DockerDesktopInstaller.exe'
            Invoke-Download "https://desktop.docker.com/win/main/$(Get-Arch)/Docker%20Desktop%20Installer.exe" $exe
            if (Confirm-Action $exe 'Run Docker Desktop installer silently') {
                $p = Start-Process -FilePath $exe -ArgumentList 'install', '--quiet', '--accept-license', '--backend=wsl-2' -Wait -PassThru
                if ($p.ExitCode -ne 0) { throw "Docker Desktop installer exited with code $($p.ExitCode)" }
            }
        } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue -WhatIf:$false }
    }

    try {
        # Exit code 2 = user is already a member.
        Invoke-Native -FilePath 'net' -ArgumentList @('localgroup', 'docker-users', $env:USERNAME, '/add') -AllowedExitCodes @(0, 2)
    } catch {
        Write-Warn "Could not add $env:USERNAME to docker-users: $($_.Exception.Message)"
    }
    Update-SessionPath
    $script:Notes.Add('Sign out and back in (or reboot) so the docker-users group membership takes effect, then start Docker Desktop.')
}

function Install-DockerMac {
    $tmp = New-TempDir
    $mount = Join-Path $tmp 'mnt'
    $attached = $false
    try {
        $dmg = Join-Path $tmp 'Docker.dmg'
        Invoke-Download "https://desktop.docker.com/mac/main/$(Get-Arch)/Docker.dmg" $dmg
        if (-not $WhatIfPreference) {
            Write-Info 'Docker Desktop install needs administrator rights; you may be prompted for your password.'
            [void][System.IO.Directory]::CreateDirectory($mount)
        }
        Invoke-Native -FilePath 'hdiutil' -ArgumentList @('attach', $dmg, '-nobrowse', '-quiet', '-mountpoint', $mount)
        $attached = -not $WhatIfPreference
        Invoke-Sudo -FilePath (Join-Path $mount 'Docker.app/Contents/MacOS/install') -ArgumentList @('--accept-license', "--user=$env:USER")
    } finally {
        if ($attached) { try { & hdiutil detach $mount -quiet | Out-Null } catch { Write-Warn "Could not detach $mount" } }
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue -WhatIf:$false
    }
    $script:Notes.Add('Open Docker Desktop once (/Applications/Docker.app) to finish setup.')
}

function Get-OsRelease {
    $info = @{}
    if (Test-Path '/etc/os-release') {
        foreach ($line in Get-Content '/etc/os-release') {
            if ($line -match '^([A-Z_]+)=(.*)$') { $info[$Matches[1]] = $Matches[2].Trim('"') }
        }
    }
    return $info
}

function Invoke-SudoScript([string]$Script) {
    # Written to a file rather than passed via 'sh -c' so embedded quotes survive any pwsh version.
    if (-not (Confirm-Action "sh <<EOF`n$Script`nEOF" 'Run as root')) { return }
    $tmp = New-TempDir
    try {
        $file = Join-Path $tmp 'step.sh'
        [System.IO.File]::WriteAllText($file, ($Script -replace "`r`n", "`n"))
        Invoke-Sudo -FilePath 'sh' -ArgumentList @($file)
    } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue -WhatIf:$false }
}

function Install-DockerDesktopDebian([hashtable]$Os) {
    $id = $Os['ID']; $like = "$($Os['ID_LIKE'])"
    if ($id -eq 'debian')                           { $distro = 'debian' }
    elseif ($id -eq 'ubuntu' -or $like -match 'ubuntu') { $distro = 'ubuntu' }
    else                                            { $distro = 'debian' }

    $repoSetup = @"
set -e
apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/$distro/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=`$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$distro `${UBUNTU_CODENAME:-`$VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
apt-get update
"@
    Invoke-SudoScript $repoSetup

    $tmp = New-TempDir
    try {
        $deb = Join-Path $tmp 'docker-desktop-amd64.deb'
        Invoke-Download 'https://desktop.docker.com/linux/main/amd64/docker-desktop-amd64.deb' $deb
        Invoke-Sudo -FilePath 'chmod' -ArgumentList @('a+rx', $tmp)  # let apt's _apt user read the file
        Invoke-Sudo -FilePath 'apt-get' -ArgumentList @('install', '-y', $deb)
    } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue -WhatIf:$false }
}

function Install-DockerDesktopFedora {
    Invoke-Sudo -FilePath 'curl' -ArgumentList @('-fsSL', 'https://download.docker.com/linux/fedora/docker-ce.repo', '-o', '/etc/yum.repos.d/docker-ce.repo')
    Invoke-Sudo -FilePath 'dnf' -ArgumentList @('install', '-y', 'https://desktop.docker.com/linux/main/amd64/docker-desktop-x86_64.rpm')
}

function Install-DockerEngineLinux {
    Write-Info 'Installing Docker Engine via get.docker.com'
    Invoke-SudoScript 'curl -fsSL https://get.docker.com | sh'
    if (Test-Command 'systemctl') {
        try { Invoke-Sudo -FilePath 'systemctl' -ArgumentList @('enable', '--now', 'docker') }
        catch { Write-Warn "Could not enable the docker service: $($_.Exception.Message)" }
    }
    $user = $env:SUDO_USER
    if (-not $user) { $user = $env:USER }
    if ($user -and $user -ne 'root') {
        Invoke-Sudo -FilePath 'usermod' -ArgumentList @('-aG', 'docker', $user)
        $script:Notes.Add("Log out and back in so '$user' can run docker without sudo.")
    }
}

function Install-DockerLinux {
    if (-not (Test-Command 'curl')) { throw 'curl is required to install Docker on Linux.' }
    $os = Get-OsRelease
    $id = "$($os['ID'])"; $like = "$($os['ID_LIKE'])"

    $reason = $null
    if ($DockerEngine)                                { $reason = '-DockerEngine was specified' }
    elseif ((Get-Arch) -ne 'amd64')                   { $reason = 'Docker Desktop for Linux requires x86_64' }
    elseif (-not (Test-Path '/dev/kvm'))              { $reason = 'KVM (/dev/kvm) is not available' }
    elseif (-not ($env:DISPLAY -or $env:WAYLAND_DISPLAY)) { $reason = 'no graphical session detected' }

    $family = $null
    if (-not $reason) {
        if ("$id $like" -match 'ubuntu|debian') { $family = 'debian' }
        elseif ($id -eq 'fedora')                { $family = 'fedora' }
        else { $reason = "Docker Desktop is not supported on '$id' by this script" }
    }

    if ($reason) {
        Write-Info "Using Docker Engine: $reason"
        Install-DockerEngineLinux
        return 'installed (Engine)'
    }

    try {
        if ($family -eq 'debian') { Install-DockerDesktopDebian $os } else { Install-DockerDesktopFedora }
        $script:Notes.Add('Start Docker Desktop from your applications menu (or: systemctl --user start docker-desktop).')
        return 'installed (Desktop)'
    } catch {
        Write-Warn "Docker Desktop install failed ($($_.Exception.Message)); falling back to Docker Engine"
        Install-DockerEngineLinux
        return 'installed (Engine fallback)'
    }
}

function Install-Docker {
    Write-Step 'Docker'
    if (Test-DockerInstalled) {
        Write-Ok 'Already installed'
        return 'already present'
    }
    $status = 'installed'
    if ($script:OnWindows)   { Install-DockerWindows }
    elseif ($script:OnMac)   { Install-DockerMac }
    elseif ($script:OnLinux) { $status = Install-DockerLinux }

    if ($WhatIfPreference) { return 'would install' }
    if (-not (Test-DockerInstalled)) { throw 'Docker installation finished but Docker was not found.' }
    Write-Ok $status
    return $status
}

# --------------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------------
if (-not ($script:OnWindows -or $script:OnMac -or $script:OnLinux)) {
    throw 'Unsupported operating system.'
}

$osName = if ($script:OnWindows) { 'Windows' } elseif ($script:OnMac) { 'macOS' } else { 'Linux' }
Write-Host "Docker + Ollama installer  |  OS: $osName  |  Arch: $(Get-Arch)  |  PowerShell $($PSVersionTable.PSVersion)"

# Windows: re-launch elevated (installers need admin). Skipped for -WhatIf dry runs.
if ($script:OnWindows -and -not $WhatIfPreference) {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Host 'Re-launching as Administrator...'
        $hostExe = (Get-Process -Id $PID).Path
        $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
        foreach ($kv in $PSBoundParameters.GetEnumerator()) {
            if ($kv.Value -is [System.Management.Automation.SwitchParameter]) {
                if ($kv.Value.IsPresent) { $argList += "-$($kv.Key)" }
            } else {
                $argList += "-$($kv.Key)"
                $argList += "`"$(@($kv.Value) -join ',')`""
            }
        }
        $p = Start-Process -FilePath $hostExe -ArgumentList $argList -Verb RunAs -Wait -PassThru
        exit $p.ExitCode
    }
}

$steps = @(
    @{ Name = 'Ollama';  Skip = [bool]$SkipOllama; Action = { Install-Ollama } },
    @{ Name = 'Models';  Skip = [bool]$SkipModels; Action = { Invoke-ModelPull } },
    @{ Name = 'Docker';  Skip = [bool]$SkipDocker; Action = { Install-Docker } }
)

foreach ($step in $steps) {
    if ($step.Skip) { $script:Results[$step.Name] = 'skipped'; continue }
    try {
        $out = & $step.Action
        $script:Results[$step.Name] = "$(@($out)[-1])"
    } catch {
        Write-Warn "$($step.Name) failed: $($_.Exception.Message)"
        $script:Results[$step.Name] = "FAILED: $($_.Exception.Message)"
    }
}

Write-Step 'Summary'
foreach ($k in $script:Results.Keys) {
    $v = $script:Results[$k]
    $color = if ($v -like 'FAILED*') { 'Red' } elseif ($v -eq 'skipped') { 'DarkGray' } else { 'Green' }
    Write-Host ("    {0,-8} {1}" -f $k, $v) -ForegroundColor $color
}
if ($script:Notes.Count -gt 0) {
    Write-Host "`n    Next steps:" -ForegroundColor Yellow
    foreach ($n in ($script:Notes | Select-Object -Unique)) { Write-Host "     - $n" -ForegroundColor Yellow }
}

$failedSteps = @($script:Results.Values | Where-Object { $_ -like 'FAILED*' })
if ($failedSteps.Count -gt 0) { exit 1 }
exit 0
