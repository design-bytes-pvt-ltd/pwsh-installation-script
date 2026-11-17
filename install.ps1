<#
.SYNOPSIS
    Installs Ollama, pulls Ollama models and installs Docker Desktop on Windows, macOS or Linux.

.DESCRIPTION
    Each step is idempotent: tools that are already installed are detected and skipped. Use
    -WhatIf for a dry run that only prints what would be done.

    Unless -Models is given, the script lists the models from models.json, tags the ones that
    fit this machine's memory (NVIDIA VRAM, Apple unified memory or system RAM) as recommended,
    and asks which ones to pull. Without an interactive console it pulls the largest
    recommended model, so the rest of the run stays unattended.

    Windows : winget (falls back to the official installers). Re-launches itself elevated.
    macOS   : official Ollama zip and Docker Desktop DMG (prompts once for sudo for Docker).
    Linux   : official Ollama install script. Docker Desktop on Ubuntu/Debian/Fedora (x86_64,
              KVM and a graphical session required), otherwise Docker Engine via get.docker.com.

.PARAMETER Models
    Ollama models to pull. Accepts an array or a comma-separated string. When omitted, the
    script asks which models from models.json to pull.

.PARAMETER ModelsFile
    Path to the model list JSON. Default: models.json next to this script.

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
    [string[]]$Models,
    [string]$ModelsFile,
    [switch]$SkipOllama,
    [switch]$SkipModels,
    [switch]$SkipDocker,
    [switch]$DockerEngine,
    [Parameter(DontShow)][string]$InvokingUser,
    [Parameter(DontShow)][string]$InvokingProfile
)

$ErrorActionPreference = 'Stop'
$script:Ctx = $PSCmdlet
$script:ScriptBoundParameters = $PSBoundParameters

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
    if ($script:OnWindows -and $PSVersionTable.PSEdition -eq 'Desktop') {
        $proto = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        if ([Enum]::IsDefined([Net.SecurityProtocolType], 'Tls13')) {
            $proto = $proto -bor [Net.SecurityProtocolType]::Tls13
        }
        [Net.ServicePointManager]::SecurityProtocol = $proto
    }
    $oldProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'   # progress bar makes IWR very slow on 5.1
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
    } finally {
        $ProgressPreference = $oldProgress
    }
}

function Get-TargetUser {
    if ($script:OnWindows) {
        if ($InvokingUser) { return $InvokingUser }
        return $env:USERNAME
    }
    if ($env:SUDO_USER) { return $env:SUDO_USER }
    return $env:USER
}

function Get-TargetUserProfile {
    if ($script:OnWindows) {
        if ($InvokingProfile) { return $InvokingProfile }
        return $env:USERPROFILE
    }
    return $env:HOME
}

function Get-OllamaBaseUrl {
    $raw = "$env:OLLAMA_HOST".Trim()
    if (-not $raw) { return 'http://127.0.0.1:11434' }
    if ($raw -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://') { $raw = "http://$raw" }
    $uri = [Uri]$raw
    $hostPart = if ($uri.Host -in @('0.0.0.0', '::', '[::]')) { '127.0.0.1' } else { $uri.Host }
    $hasExplicitPort = $raw -match '^[a-zA-Z][a-zA-Z0-9+.-]*://(\[[^\]]+\]|[^/:]+):(\d+)'
    $port = if ($hasExplicitPort) { $uri.Port } elseif ($uri.Scheme -eq 'http') { 11434 } else { $uri.Port }
    return "$($uri.Scheme)://${hostPart}:${port}"
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
# Model selection
# --------------------------------------------------------------------------------------------
function Get-SystemMemoryGB {
    try {
        if ($script:OnWindows) {
            $bytes = [double](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
        } elseif ($script:OnMac) {
            $bytes = [double]("$(& sysctl -n hw.memsize)".Trim())
        } else {
            $line = Get-Content '/proc/meminfo' | Where-Object { $_ -match '^MemTotal:\s+\d+' } | Select-Object -First 1
            if (-not ($line -match '^MemTotal:\s+(\d+)')) { return $null }
            $bytes = [double]$Matches[1] * 1KB
        }
        if ($bytes -le 0) { return $null }
        return [math]::Round($bytes / 1GB, 1)
    } catch { return $null }
}

function Get-GpuMemoryGB {
    # NVIDIA only. Win32_VideoController.AdapterRAM is a 32-bit value capped at 4 GB, so it is not used.
    $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if (-not $smi) { return $null }
    $oldEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $smi.Source --query-gpu=memory.total --format=csv,noheader,nounits 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        $mib = @($out | ForEach-Object { "$_".Trim() } | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [double]$_ })
        if ($mib.Count -eq 0) { return $null }
        return [math]::Round(($mib | Measure-Object -Maximum).Maximum / 1024, 1)
    } catch { return $null }
    finally { $ErrorActionPreference = $oldEap }
}

function Get-ModelBudget {
    # Memory (GB) a model can use and still run fast on this machine.
    $ram  = Get-SystemMemoryGB
    $vram = Get-GpuMemoryGB
    if ($vram) {
        return @{ Budget = $vram; Ram = $ram; Source = "NVIDIA GPU with $vram GB VRAM" }
    }
    if (-not $ram) { return $null }
    if ($script:OnMac -and (Get-Arch) -eq 'arm64') {
        # Metal can use about 2/3 of unified memory by default.
        return @{ Budget = [math]::Round($ram * 0.65, 1); Ram = $ram; Source = "Apple silicon with $ram GB unified memory" }
    }
    # CPU inference: leave half the RAM for the OS, Docker and other apps.
    return @{ Budget = [math]::Round($ram * 0.5, 1); Ram = $ram; Source = "CPU with $ram GB RAM" }
}

function Get-ModelCatalog([string]$Path) {
    $fallback = @([pscustomobject]@{ name = 'qwen3:0.6b'; description = 'Qwen3 0.6B (built-in default)'; size_gb = 0.5; min_memory_gb = 2 })
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) {
        Write-Warn "Model list not found$(if ($Path) { " at $Path" }); using the built-in default."
        return $fallback
    }
    try {
        $models = @((Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json).models | Where-Object { $_ -and $_.name })
        if ($models.Count -eq 0) { throw 'it has no entries with a "name" field' }
        return $models
    } catch {
        Write-Warn "Could not read ${Path}: $($_.Exception.Message). Using the built-in default."
        return $fallback
    }
}

function Get-ModelMinMemory($Model) {
    if ($Model.min_memory_gb) { return [double]$Model.min_memory_gb }
    if ($Model.size_gb)       { return [math]::Ceiling([double]$Model.size_gb * 1.2 + 1) }
    return $null
}

function Get-ModelTier($Model, $Budget) {
    $need = Get-ModelMinMemory $Model
    if (-not $Budget -or $null -eq $need) { return '' }
    if ($need -le $Budget.Budget) { return 'recommended' }
    $ram = if ($Budget.Ram) { $Budget.Ram } else { $Budget.Budget }
    if ($need -le $ram) { return 'may be slow' }   # fits in RAM but runs (partly) on the CPU
    return 'too large'
}

function Test-Interactive {
    if (-not [Environment]::UserInteractive) { return $false }
    try { if ([Console]::IsInputRedirected) { return $false } } catch { }
    if (@([Environment]::GetCommandLineArgs() | Where-Object { $_ -match '^-noni' }).Count -gt 0) { return $false }
    return $true
}

function ConvertTo-Selection([string]$Text, [int]$Count) {
    # Parses "1,3 5-7" into 0-based indexes. Returns $null if any token is invalid.
    $idx = New-Object System.Collections.Generic.List[int]
    foreach ($tok in ($Text -split '[,\s]+' | Where-Object { $_ })) {
        if ($tok -match '^(\d+)-(\d+)$') { $a = [int]$Matches[1]; $b = [int]$Matches[2] }
        elseif ($tok -match '^\d+$')     { $a = [int]$tok; $b = $a }
        else { return $null }
        if ($a -lt 1 -or $b -gt $Count -or $a -gt $b) { return $null }
        for ($i = $a; $i -le $b; $i++) { if (-not $idx.Contains($i - 1)) { $idx.Add($i - 1) } }
    }
    if ($idx.Count -eq 0) { return $null }
    return , $idx.ToArray()
}

function ConvertTo-ModelKey([string]$Name) {
    # Normalizes a model reference so "phi4-mini", "phi4-mini:latest" and
    # "registry.ollama.ai/library/phi4-mini:latest" all compare equal.
    $n = $Name.Trim().ToLowerInvariant()
    if ($n -notmatch ':[^/]+$')                { $n += ':latest' }
    if ($n.StartsWith('registry.ollama.ai/')) { $n = $n.Substring('registry.ollama.ai/'.Length) }
    if ($n.StartsWith('library/'))            { $n = $n.Substring('library/'.Length) }
    return $n
}

function Get-InstalledModels {
    # Returns @{ <model key> = @{ Name; Size } } for models already downloaded, where Name keeps
    # the original spelling and Size is in GB. Asks the running
    # Ollama server first; otherwise reads the manifests on disk, so it works before Ollama starts.
    $installed = @{}
    if (Test-OllamaServer) {
        try {
            $tags = Invoke-RestMethod -Uri "$(Get-OllamaBaseUrl)/api/tags" -TimeoutSec 5 -UseBasicParsing
            foreach ($m in @($tags.models)) {
                if ($m.name) {
                    $installed[(ConvertTo-ModelKey $m.name)] = @{ Name = "$($m.name)"; Size = [math]::Round([double]$m.size / 1GB, 1) }
                }
            }
            return $installed
        } catch { }
    }

    $userHome = Get-TargetUserProfile
    $roots = @()
    if ($env:OLLAMA_MODELS) { $roots += $env:OLLAMA_MODELS }
    if ($userHome)          { $roots += (Join-Path $userHome '.ollama/models') }
    if ($script:OnLinux)    { $roots += '/usr/share/ollama/.ollama/models' }   # systemd service install

    foreach ($root in $roots) {
        $manifests = Join-Path $root 'manifests'
        if (-not (Test-Path -LiteralPath $manifests)) { continue }
        # Layout: manifests/<registry>/<namespace>/<model>/<tag>
        foreach ($f in @(Get-ChildItem -LiteralPath $manifests -Recurse -File -ErrorAction SilentlyContinue)) {
            $parts = @(($f.FullName.Substring($manifests.Length) -replace '\\', '/').Trim('/') -split '/')
            if ($parts.Count -lt 3) { continue }
            $ref = "{0}:{1}" -f ($parts[0..($parts.Count - 2)] -join '/'), $parts[-1]
            $key = ConvertTo-ModelKey $ref
            if ($installed.ContainsKey($key)) { continue }
            $ref = $ref -replace '^registry\.ollama\.ai/', '' -replace '^library/', ''
            $size = $null
            try {
                $manifest = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json
                $bytes = (@($manifest.layers) + @($manifest.config) | Where-Object { $_ } |
                          ForEach-Object { [double]$_.size } | Measure-Object -Sum).Sum
                if ($bytes) { $size = [math]::Round($bytes / 1GB, 1) }
            } catch { }
            $installed[$key] = @{ Name = $ref; Size = $size }
        }
    }
    return $installed
}

function Get-CheckMark {
    # The classic Windows console fonts (Consolas, Lucida Console) have no U+2713, so use a
    # square-root sign there. Windows Terminal and VS Code have fonts with a real check mark.
    if ($script:OnWindows -and -not $env:WT_SESSION -and -not $env:TERM_PROGRAM) { return [string][char]0x221A }
    return [string][char]0x2713
}

function Get-TierColor([string]$Tier) {
    switch ($Tier) {
        'recommended' { return 'Green' }
        'may be slow' { return 'Yellow' }
        'too large'   { return 'DarkGray' }
        default       { return $null }
    }
}

function Format-ModelSize($Size) {
    if ($Size) { return '{0:0.0} GB' -f [double]$Size }
    return '?'
}

function Get-NameWidth($Rows) {
    return [math]::Max(5, ($Rows | ForEach-Object { $_.Name.Length } | Measure-Object -Maximum).Maximum)
}

function Write-ModelTable($Rows, $Default) {
    $nameWidth = Get-NameWidth $Rows
    Write-Host ''
    Write-Host ("    {0,3}  {1}  {2,7}  {3,-14}{4,-11}{5}" -f '#', 'Model'.PadRight($nameWidth), 'Size', 'Fit', 'Status', 'Description')
    foreach ($r in $Rows) {
        $marker = if ($r.Index -eq $Default.Index) { '*' } else { ' ' }
        $tag    = if ($r.Tier) { "[$($r.Tier)]" } else { '' }
        Write-Host ("    {0,3}{1} {2}  {3,7}  " -f $r.Index, $marker, $r.Name.PadRight($nameWidth), (Format-ModelSize $r.Size)) -NoNewline
        $color = Get-TierColor $r.Tier
        if ($color) { Write-Host ('{0,-14}' -f $tag) -ForegroundColor $color -NoNewline }
        else        { Write-Host ('{0,-14}' -f $tag) -NoNewline }
        if ($r.Installed) { Write-Host ('{0,-11}' -f 'installed') -ForegroundColor DarkCyan -NoNewline }
        else              { Write-Host (' ' * 11) -NoNewline }
        Write-Host $r.Description
    }
    Write-Host "    * = default"
    Write-Host ''
}

function Test-MenuSupported {
    if ($Host.Name -eq 'Windows PowerShell ISE Host') { return $false }
    try { return ([Console]::WindowWidth -ge 40 -and [Console]::WindowHeight -ge 10) }
    catch { return $false }
}

function Write-MenuLine([object[]]$Segments, [int]$Width) {
    # Writes one console line from (text, color) pairs, cut/padded to exactly $Width columns so
    # it fully overwrites whatever was drawn there before. A $null color means the default.
    $left = $Width
    for ($i = 0; $i -lt $Segments.Count -and $left -gt 0; $i += 2) {
        $text = [string]$Segments[$i]
        if ($text.Length -gt $left) { $text = $text.Substring(0, $left) }
        if ($Segments[$i + 1]) { Write-Host $text -ForegroundColor $Segments[$i + 1] -NoNewline }
        else                   { Write-Host $text -NoNewline }
        $left -= $text.Length
    }
    if ($left -gt 0) { Write-Host (' ' * $left) -NoNewline }
    Write-Host ''
}

function Show-ModelMenu($Rows, $Default) {
    # Arrow-key checkbox list. Returns the names of the checked models (empty = skip).
    $count     = $Rows.Count
    $checked   = New-Object bool[] $count
    $checked[$Default.Index - 1] = $true
    $cursor    = $Default.Index - 1
    $offset    = 0
    $nameWidth = Get-NameWidth $Rows
    $width     = [Console]::WindowWidth - 1
    $view      = [math]::Min($count, [Console]::WindowHeight - 6)   # model rows visible at once
    $lines     = $view + 3                                          # help + header + rows + status
    $status    = $null
    $tick      = Get-CheckMark

    # Redraw in place. With VT support, move the cursor up relative to where the last draw ended;
    # this avoids [Console]::CursorTop, which on macOS/Linux queries the terminal and can swallow
    # keystrokes if the reply is slow. Otherwise (old Windows consoles) use absolute positions.
    $useVt = $false
    try { $useVt = [bool]$Host.UI.SupportsVirtualTerminal } catch { }
    $moveUp = "$([char]27)[${lines}A`r"
    $top    = 0
    $script:MenuDrawn = $false   # set by $draw, which runs in a child scope
    Write-Host ''
    if (-not $useVt) {
        # Reserve the space first (this scrolls the screen if needed).
        for ($i = 0; $i -lt $lines; $i++) { Write-Host '' }
        $top = [math]::Max(0, [Console]::CursorTop - $lines)
    }

    $draw = {
        if (-not $useVt)           { [Console]::SetCursorPosition(0, $top) }
        elseif ($script:MenuDrawn) { Write-Host $moveUp -NoNewline }
        $script:MenuDrawn = $true
        Write-MenuLine @('  Up/Down: move   Space: select   A: all/none   Enter: confirm   Esc: skip models', 'DarkGray') $width
        Write-MenuLine @(("       {0}  {1,7}  {2,-14}{3,-11}{4}" -f 'Model'.PadRight($nameWidth), 'Size', 'Fit', 'Status', 'Description'), $null) $width
        for ($i = $offset; $i -lt $offset + $view; $i++) {
            $r       = $Rows[$i]
            $current = ($i -eq $cursor)
            $pointer = if ($current) { '>' } else { ' ' }
            $box     = if ($checked[$i]) { "[$tick]" } else { '[ ]' }
            $main    = if ($current) { 'Cyan' } else { $null }
            $tag     = if ($r.Tier) { "[$($r.Tier)]" } else { '' }
            $state   = if ($r.Installed) { 'installed' } else { '' }
            Write-MenuLine @(
                " $pointer ", $main,
                $box, $(if ($checked[$i]) { 'Green' } else { $main }),
                (" {0}  {1,7}  " -f $r.Name.PadRight($nameWidth), (Format-ModelSize $r.Size)), $main,
                ('{0,-14}' -f $tag), (Get-TierColor $r.Tier),
                ('{0,-11}' -f $state), 'DarkCyan',
                $r.Description, $main
            ) $width
        }
        if ($status) {
            Write-MenuLine @("  $status", 'Yellow') $width
        } else {
            $sel   = @(for ($i = 0; $i -lt $count; $i++) { if ($checked[$i]) { $Rows[$i] } })
            $gb    = ($sel | Where-Object { -not $_.Installed } | ForEach-Object { [double]$_.Size } | Measure-Object -Sum).Sum
            $more  = @()
            if ($offset -gt 0)              { $more += 'more above' }
            if ($offset + $view -lt $count) { $more += 'more below' }
            $text  = "  {0} selected ({1:0.0} GB to download)" -f $sel.Count, $gb
            if ($more) { $text += "   ($($more -join ', '))" }
            Write-MenuLine @($text, 'DarkGray') $width
        }
    }

    $cursorWasVisible = $null
    try { $cursorWasVisible = [Console]::CursorVisible } catch { }
    try { [Console]::CursorVisible = $false } catch { }
    try {
        while ($true) {
            if ($cursor -lt $offset)          { $offset = $cursor }
            if ($cursor -ge $offset + $view)  { $offset = $cursor - $view + 1 }
            & $draw
            $status = $null

            $key = [Console]::ReadKey($true)
            $name = "$($key.Key)"
            if ($key.KeyChar -eq 'k') { $name = 'UpArrow' }
            if ($key.KeyChar -eq 'j') { $name = 'DownArrow' }
            switch ($name) {
                'UpArrow'   { $cursor = ($cursor - 1 + $count) % $count }
                'DownArrow' { $cursor = ($cursor + 1) % $count }
                'Home'      { $cursor = 0 }
                'End'       { $cursor = $count - 1 }
                'PageUp'    { $cursor = [math]::Max(0, $cursor - $view) }
                'PageDown'  { $cursor = [math]::Min($count - 1, $cursor + $view) }
                'Spacebar'  { $checked[$cursor] = -not $checked[$cursor] }
                'A' {
                    $all = ($checked -notcontains $false)
                    for ($i = 0; $i -lt $count; $i++) { $checked[$i] = -not $all }
                }
                'Escape' { return }
                'Enter' {
                    $chosen   = @(for ($i = 0; $i -lt $count; $i++) { if ($checked[$i]) { $Rows[$i] } })
                    $tooLarge = @($chosen | Where-Object { $_.Tier -eq 'too large' })
                    if ($tooLarge.Count -gt 0) {
                        $status = "Too large for this machine: $(($tooLarge | ForEach-Object { $_.Name }) -join ', '). Pull anyway? [y/N]"
                        & $draw
                        $status = $null
                        if ([Console]::ReadKey($true).KeyChar -notmatch '^[yY]$') { break }
                    }
                    return @($chosen | ForEach-Object { $_.Name })
                }
            }
        }
    } finally {
        if (-not $useVt) { try { [Console]::SetCursorPosition(0, $top + $lines) } catch { } }
        if ($null -ne $cursorWasVisible) { try { [Console]::CursorVisible = $cursorWasVisible } catch { } }
        else { try { [Console]::CursorVisible = $true } catch { } }
    }
}

function Select-Models {
    $path = $ModelsFile
    if (-not $path -and $PSScriptRoot) { $path = Join-Path $PSScriptRoot 'models.json' }

    Write-Step 'Choose Ollama models'
    $catalog = @(Get-ModelCatalog $path | Sort-Object { [double]$_.size_gb }, name)
    $budget  = Get-ModelBudget
    if ($budget) {
        Write-Info "Detected: $($budget.Source). Recommending models that need up to $($budget.Budget) GB."
    } else {
        Write-Warn 'Could not detect system memory; no models are marked recommended.'
    }

    $installed = Get-InstalledModels
    if ($installed.Count -gt 0) { Write-Info "Already downloaded: $($installed.Count) model(s)." }

    # Downloaded models that aren't in the catalog are listed too, after the catalog entries.
    $catalogKeys = @($catalog | ForEach-Object { ConvertTo-ModelKey $_.name })
    $extras = @($installed.Keys | Where-Object { $catalogKeys -notcontains $_ } | ForEach-Object {
        $name = $installed[$_].Name -replace ':latest$', ''
        [pscustomobject]@{ name = $name; description = 'Downloaded earlier (not in models.json)'; size_gb = $installed[$_].Size }
    } | Sort-Object { [double]$_.size_gb }, name)

    $all  = @($catalog) + @($extras)
    $rows = @(for ($i = 0; $i -lt $all.Count; $i++) {
        $m = $all[$i]
        [pscustomobject]@{
            Index       = $i + 1
            Name        = "$($m.name)"
            Size        = $m.size_gb
            Tier        = Get-ModelTier $m $budget
            Installed   = $installed.ContainsKey((ConvertTo-ModelKey $m.name))
            Description = "$($m.description)"
        }
    })

    # Default: the largest recommended catalog model, else the smallest one.
    $recommended = @($rows | Where-Object { $_.Index -le $catalog.Count -and $_.Tier -eq 'recommended' })
    $default = if ($recommended.Count -gt 0) { $recommended[-1] } else { $rows[0] }

    $interactive = Test-Interactive
    if ($interactive -and (Test-MenuSupported)) {
        try {
            $picked = @(Show-ModelMenu $rows $default)
            if ($picked.Count -gt 0) { Write-Ok "Selected: $($picked -join ', ')" } else { Write-Info 'No models selected.' }
            return $picked
        } catch {
            Write-Warn "Arrow-key menu unavailable ($($_.Exception.Message)); using the numbered list."
        }
    }

    Write-ModelTable $rows $default
    if (-not $interactive) {
        Write-Info "No interactive console; pulling the default: $($default.Name)"
        return $default.Name
    }

    # Fallback for hosts without a usable console (e.g. the PowerShell ISE): type numbers.
    while ($true) {
        $answer = "$(Read-Host "    Select models (e.g. 1,3 or 2-4 / all / none) [Enter = $($default.Name)]")".Trim()
        if (-not $answer)                     { $chosen = @($default) }
        elseif ($answer -match '^(all|a)$')   { $chosen = $rows }
        elseif ($answer -match '^(none|n)$')  { return }
        else {
            $sel = ConvertTo-Selection $answer $rows.Count
            if ($null -eq $sel) {
                Write-Warn "Enter numbers from 1 to $($rows.Count), ranges like 2-4, 'all' or 'none'."
                continue
            }
            $chosen = @($sel | ForEach-Object { $rows[$_] })
        }

        $tooLarge = @($chosen | Where-Object { $_.Tier -eq 'too large' })
        if ($tooLarge.Count -gt 0) {
            Write-Warn "Too large for this machine: $(($tooLarge | ForEach-Object { $_.Name }) -join ', ')"
            if ("$(Read-Host '    Pull them anyway? [y/N]')".Trim() -notmatch '^(y|yes)$') { continue }
        }
        return @($chosen | ForEach-Object { $_.Name })
    }
}

# --------------------------------------------------------------------------------------------
# Ollama
# --------------------------------------------------------------------------------------------
function Get-OllamaExe {
    $cmd = Get-Command ollama -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @()
    if ($script:OnWindows) {
        $profileDir = Get-TargetUserProfile
        if ($profileDir) { $candidates += (Join-Path $profileDir 'AppData\Local\Programs\Ollama\ollama.exe') }
        if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe') }
    }
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
        $null = Invoke-RestMethod -Uri "$(Get-OllamaBaseUrl)/api/version" -TimeoutSec 2 -UseBasicParsing
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
    throw "Ollama server did not become reachable on $(Get-OllamaBaseUrl) (see $log.err)."
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

    $targetUser = Get-TargetUser
    try {
        # Exit code 2 = user is already a member.
        Invoke-Native -FilePath 'net' -ArgumentList @('localgroup', 'docker-users', $targetUser, '/add') -AllowedExitCodes @(0, 2)
    } catch {
        Write-Warn "Could not add $targetUser to docker-users: $($_.Exception.Message)"
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
        $targetUser = Get-TargetUser
        Invoke-Sudo -FilePath (Join-Path $mount 'Docker.app/Contents/MacOS/install') -ArgumentList @('--accept-license', "--user=$targetUser")
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
function Invoke-Main {
    if (-not ($script:OnWindows -or $script:OnMac -or $script:OnLinux)) {
        throw 'Unsupported operating system.'
    }

    $osName = if ($script:OnWindows) { 'Windows' } elseif ($script:OnMac) { 'macOS' } else { 'Linux' }
    Write-Host "Docker + Ollama installer  |  OS: $osName  |  Arch: $(Get-Arch)  |  PowerShell $($PSVersionTable.PSVersion)"

    # Ask which models to pull. Runs before the Windows elevation so the prompt appears in the
    # user's own console; the answer is forwarded to the elevated process via $script:ScriptBoundParameters.
    if (-not $script:SkipModels -and -not $script:ScriptBoundParameters.ContainsKey('Models')) {
        $script:Models = @(Select-Models)
        if ($script:Models.Count -eq 0) {
            $script:SkipModels = [switch]$true
            $script:ScriptBoundParameters['SkipModels'] = [switch]$true
        } else {
            $script:ScriptBoundParameters['Models'] = $script:Models
        }
    }

    # Windows: re-launch elevated (installers need admin). Skipped for -WhatIf dry runs.
    if ($script:OnWindows -and -not $WhatIfPreference) {
        $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            if (-not $PSCommandPath) {
                throw 'Self-elevation on Windows requires running install.ps1 from a file. Save the script locally or run from an elevated PowerShell.'
            }
            if (-not $script:ScriptBoundParameters.ContainsKey('InvokingUser') -and $env:USERNAME) {
                $script:ScriptBoundParameters['InvokingUser'] = $env:USERNAME
            }
            if (-not $script:ScriptBoundParameters.ContainsKey('InvokingProfile') -and $env:USERPROFILE) {
                $script:ScriptBoundParameters['InvokingProfile'] = $env:USERPROFILE
            }
            Write-Host 'Re-launching as Administrator...'
            $hostExe = (Get-Process -Id $PID).Path
            $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
            foreach ($kv in $script:ScriptBoundParameters.GetEnumerator()) {
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
        @{ Name = 'Ollama';  Skip = [bool]$script:SkipOllama; Action = { Install-Ollama } },
        @{ Name = 'Models';  Skip = [bool]$script:SkipModels; Action = { Invoke-ModelPull } },
        @{ Name = 'Docker';  Skip = [bool]$script:SkipDocker; Action = { Install-Docker } }
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
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-Main
}
