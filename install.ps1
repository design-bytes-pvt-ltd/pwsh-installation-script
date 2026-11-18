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

.PARAMETER LogPath
    Where to write the log file. Default: install-cli-<timestamp>.log in the same folder the
    desktop app uses (Windows: %APPDATA%\Docker + Ollama Installer\logs, macOS:
    ~/Library/Logs/Docker + Ollama Installer, Linux: ~/.config/Docker + Ollama Installer/logs).
    When a step fails, the end of the log has a FAILURE REPORT with the failing command, its
    exit code, the last lines of output, where it failed and a hint.

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
    [string]$LogPath,
    [Parameter(DontShow)][string]$InvokingUser,
    [Parameter(DontShow)][string]$InvokingProfile,
    [Parameter(DontShow)][string]$ResultFile
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
# Console output; everything is also written to the log file (see Write-InstallLog).
function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
    if ($Message -ne $script:LogStep -and $Message -ne 'Summary') { Write-InstallLog 'INFO' $Message }
}
function Write-Ok([string]$Message)   { Write-Host "    [ok] $Message" -ForegroundColor Green; Write-InstallLog 'INFO' $Message }
function Write-Info([string]$Message) { Write-Host "    $Message"; Write-InstallLog 'INFO' $Message }
function Write-Warn([string]$Message) { Write-Host "    [warn] $Message" -ForegroundColor Yellow; Write-InstallLog 'WARN' $Message }

function Add-Note([string]$Text) {
    # Follow-up steps for the summary. Dry runs change nothing, so they get no notes.
    if (-not $WhatIfPreference) { $script:Notes.Add($Text); Write-InstallLog 'NOTE' $Text }
}

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Confirm-Action([string]$Target, [string]$Action) {
    return $script:Ctx.ShouldProcess($Target, $Action)
}

# --------------------------------------------------------------------------------------------
# Log file and failure reports
# The layout, hint table and redaction rules mirror the desktop app (app/src/main/core/errors.ts).
# tests/fixtures/error-report.parity.json is checked by both test suites: change them together.
# --------------------------------------------------------------------------------------------
$script:LogFile     = $null
$script:LogStep     = ''
$script:LogTag      = ''      # '[elevated] ' in the elevated Docker process
$script:LogWarned   = $false
$script:LogStarted  = Get-Date
$script:Failures    = New-Object System.Collections.Generic.List[object]
$script:LogRule     = '=' * 80
$script:LogThinRule = '-' * 80
$script:Utf8NoBom   = New-Object System.Text.UTF8Encoding $false
$script:ReportOutputLines = 20
$script:LogsToKeep  = 10

$script:ElevationLabels = @{
    'uac'          = 'yes (Windows UAC prompt)'
    'osascript'    = 'yes (macOS administrator prompt)'
    'pkexec'       = 'yes (pkexec)'
    'sudo-askpass' = 'yes (sudo with a password dialog)'
    'sudo'         = 'yes (sudo)'
    'root'         = 'yes (already running as root)'
}

# First match wins. Patterns are case-insensitive and shared with errors.ts.
$script:ErrorHints = @(
    @{ Id = 'elevation-cancelled'; ExitCodes = @(); Pattern = 'password prompt was cancelled|User canceled|\(-128\)|Request dismissed|Not authorized|cancell?ed by the user|no password was provided|a password is required|incorrect password attempts'
       Text = 'The administrator password prompt was cancelled or denied. Run the installer again and approve the prompt.' },
    @{ Id = 'ollama-unreachable'; ExitCodes = @(); Pattern = 'Ollama server did not become reachable|Ollama is not running|(127\.0\.0\.1|localhost):11434'
       Text = 'The Ollama server is not running. Start the Ollama app (or run ''ollama serve'') and try again.' },
    @{ Id = 'model-not-found'; ExitCodes = @(); Pattern = 'pull model manifest|file does not exist|manifest unknown'
       Text = 'Ollama could not find this model. Check the exact name and tag at https://ollama.com/library.' },
    @{ Id = 'signature-invalid'; ExitCodes = @(); Pattern = 'signature check failed|signature is missing or invalid|code object is not signed|a sealed resource is missing|invalid signature'
       Text = 'The downloaded installer failed its signature check, so it was not run. Retry on a trusted network, or download it from the vendor site.' },
    @{ Id = 'wsl-reboot'; ExitCodes = @(3010); Pattern = 'reboot is required|restart is required|restart your computer'
       Text = 'Windows needs a restart to finish this install (WSL2). Reboot, then run the installer again.' },
    @{ Id = 'dpkg-lock'; ExitCodes = @(); Pattern = 'Could not get lock|dpkg frontend lock|Unable to acquire the dpkg'
       Text = 'Another package manager (apt or Software Updater) is running. Wait for it to finish, then retry.' },
    @{ Id = 'disk-full'; ExitCodes = @(); Pattern = 'ENOSPC|No space left on device|not enough (disk )?space|disk is full'
       Text = 'The disk is full. Free some space (each model needs several GB) and retry.' },
    @{ Id = 'winget-missing'; ExitCodes = @(); Pattern = 'winget(\.exe)?.{0,40}(is not recognized|not found|ENOENT)'
       Text = 'winget (App Installer) is missing or broken. Install ''App Installer'' from the Microsoft Store and retry.' },
    @{ Id = 'needs-admin'; ExitCodes = @(740); Pattern = 'requires elevation|0x80070005|Access is denied|Permission denied|EACCES|EPERM|must be run as root|are you root'
       Text = 'This step needs administrator rights. Approve the administrator prompt, or run the installer from an administrator account.' },
    @{ Id = 'network'; ExitCodes = @(); Pattern = 'ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|getaddrinfo|Could not resolve host|Network is unreachable|Failed to download|timed out|unable to connect|certificate verify failed|unable to get local issuer certificate'
       Text = 'A network request failed. Check your internet connection, proxy or firewall, then retry.' },
    @{ Id = 'command-not-found'; ExitCodes = @(127); Pattern = 'ENOENT|command not found|is not recognized as|not found in PATH|No such file or directory'
       Text = 'A required program or file was not found. Make sure it is installed and on PATH, then retry.' }
)

# Root scripts trace each command (PS4='@@CMD ') and report the failing exit code, so a failure
# names the inner command instead of 'sh step.sh'. Same preamble as the desktop app.
$script:ShPreamble = @'
set -e
exec 2>&1
PS4='@@CMD '
trap '{ __rc=$?; set +x; } 2>/dev/null; if [ "$__rc" -ne 0 ]; then echo "@@ERROR-EXIT $__rc"; fi' EXIT
set -x
'@

function Protect-LogText([string]$Text) {
    # Masks credentials that commands sometimes echo (user:pass in URLs, token=..., auth headers).
    $t = $Text -replace '(https?://)[^/\s:@]+:[^/\s@]+@', '$1***:***@'
    $t = $t -replace '((?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*)[^\s&"'']+', '$1***'
    return ($t -replace '(Authorization:\s*(?:Bearer\s+|Basic\s+)?)[^\s"'']+', '$1***')
}

function Get-CleanLines($Lines) {
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($l in @($Lines)) {
        if ($null -eq $l) { continue }
        $t = "$l".TrimEnd()
        if ($t.Trim() -ne '') { $out.Add($t) }
    }
    return $out.ToArray()   # callers wrap the result in @() so one line is still an array
}

function Get-ErrorHint([string]$Text, $ExitCode) {
    foreach ($h in $script:ErrorHints) {
        if ($null -ne $ExitCode -and @($h.ExitCodes) -contains [int]$ExitCode) { return $h }
        if ($h.Pattern -and $Text -match $h.Pattern) { return $h }
    }
    return $null
}

function New-ErrorReport {
    # Builds a failure report from plain fields (same rules as createErrorReport in errors.ts).
    param([string]$Step, [string]$Message, [string]$Command, $ExitCode, [string]$Elevated, [string]$Where, $Output, $Details)
    $msgLines = @(Get-CleanLines ("$Message" -split '\r?\n'))
    $summary = 'Unknown error'
    if ($msgLines.Count -gt 0 -and $msgLines[0].Trim()) { $summary = $msgLines[0].Trim() }
    $det = @($msgLines | Select-Object -Skip 1) + @(Get-CleanLines $Details)
    $all = @(Get-CleanLines $Output)
    $cmd = ($Command -replace '\s+', ' ').Trim()
    $code = $null
    if ($null -ne $ExitCode -and "$ExitCode" -ne '') { $code = [int]$ExitCode }
    $hint = Get-ErrorHint -Text ((@($summary, $cmd) + $det + $all) -join "`n") -ExitCode $code
    return [pscustomobject][ordered]@{
        Step        = $Step
        Summary     = $summary
        Command     = $(if ($cmd) { $cmd } else { $null })
        ExitCode    = $code
        Elevated    = $(if ($Elevated) { $Elevated } else { $null })
        Where       = $(if ($Where.Trim()) { $Where.Trim() } else { $null })
        HintId      = $(if ($hint) { $hint.Id } else { $null })
        Hint        = $(if ($hint) { $hint.Text } else { $null })
        Output      = @($all | Select-Object -Last $script:ReportOutputLines)
        OutputTotal = $all.Count
        Details     = @($det)
    }
}

function Get-ErrorWhere($Frames, $InvocationInfo) {
    # "install.ps1 line 998 (Install-DockerLinux)" for the first frame outside the command helpers.
    foreach ($f in @($Frames)) {
        if ($f -match '^at (.+?), (.+): line (\d+)$') {
            if (@('Invoke-Native', 'Invoke-Sudo', 'Invoke-SudoScript', 'Invoke-Download') -contains $Matches[1]) { continue }
            $file = Split-Path -Leaf $Matches[2]
            if ($Matches[1] -eq '<ScriptBlock>') { return "$file line $($Matches[3])" }
            return "$file line $($Matches[3]) ($($Matches[1]))"
        }
    }
    if ($InvocationInfo -and $InvocationInfo.ScriptLineNumber) {
        return "line $($InvocationInfo.ScriptLineNumber): $("$($InvocationInfo.Line)".Trim())"
    }
    return $null
}

function ConvertTo-ErrorReport {
    # Turns a caught ErrorRecord into a failure report: message, the command context that
    # Invoke-Native attached (command, exit code, output), inner exceptions and the script stack.
    param([string]$Step, $ErrorRecord)
    $ex = if ($ErrorRecord -is [System.Exception]) { $ErrorRecord } else { $ErrorRecord.Exception }
    $data = $ex.Data
    $details = New-Object System.Collections.Generic.List[string]
    $inner = $ex.InnerException
    for ($i = 0; $inner -and $i -lt 5; $i++) {
        $details.Add("Caused by: $($inner.GetType().Name): $($inner.Message)")
        $inner = $inner.InnerException
    }
    $frames = @()
    if ($ErrorRecord -isnot [System.Exception]) {
        $frames = @("$($ErrorRecord.ScriptStackTrace)" -split '\r?\n' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    }
    if ($frames.Count -gt 0) {
        $details.Add('PowerShell stack:')
        foreach ($f in ($frames | Select-Object -First 15)) { $details.Add("  $f") }
    }
    $where = $null
    if ($ErrorRecord -isnot [System.Exception]) { $where = Get-ErrorWhere $frames $ErrorRecord.InvocationInfo }
    $isCommand = $data -and $data.Contains('Command')
    $elevated = $null
    if ($data -and $data.Contains('Elevated')) { $elevated = $data['Elevated'] }
    elseif ($ResultFile) { $elevated = 'uac' }
    $params = @{ Step = $Step; Elevated = $elevated; Where = "$where"; Details = $details.ToArray() }
    if ($isCommand) {
        $params.Message  = "Command failed (exit code $($data['ExitCode']))"
        $params.Command  = $data['Command']
        $params.ExitCode = $data['ExitCode']
        $params.Output   = $data['Output']
    } else {
        $params.Message = $ex.Message
    }
    return New-ErrorReport @params
}

function Format-LogField([string]$Name, [string]$Value) { return " $($Name.PadRight(13)) $Value" }

function Format-FailureReport($Report, [int]$Index, [int]$Total) {
    # The boxed FAILURE REPORT block, byte-identical to formatFailureReport in errors.ts.
    $r = $Report
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add($script:LogRule)
    $lines.Add(" FAILURE REPORT $Index of ${Total}: $($r.Step)")
    $lines.Add($script:LogThinRule)
    $lines.Add((Format-LogField 'What failed' $r.Summary))
    if ($r.Command) { $lines.Add((Format-LogField 'Command' $r.Command)) }
    if ($null -ne $r.ExitCode) { $lines.Add((Format-LogField 'Exit code' "$($r.ExitCode)")) }
    if ($r.Elevated) {
        $label = $script:ElevationLabels["$($r.Elevated)"]
        if (-not $label) { $label = "yes ($($r.Elevated))" }
        $lines.Add((Format-LogField 'Elevated' $label))
    }
    if ($r.Where) { $lines.Add((Format-LogField 'Where' $r.Where)) }
    if ($r.Hint) { $lines.Add((Format-LogField 'Hint' $r.Hint)) }
    $output = @(@($r.Output) | Where-Object { $null -ne $_ })
    if ($output.Count -gt 0) {
        $n = $output.Count
        if ([int]$r.OutputTotal -gt $n) { $lines.Add(" Last output (last $n of $($r.OutputTotal) lines)") }
        else { $lines.Add(" Last output ($n $(if ($n -eq 1) { 'line' } else { 'lines' }))") }
        foreach ($l in $output) { $lines.Add("   | $l") }
    }
    $details = @(@($r.Details) | Where-Object { $null -ne $_ })
    if ($details.Count -gt 0) {
        $lines.Add(' Details')
        foreach ($l in $details) { $lines.Add("   | $l") }
    }
    return (@($lines | ForEach-Object { Protect-LogText $_ }) -join "`n")
}

function Format-LogHeader($Fields) {
    $lines = @(
        $script:LogRule,
        ' Docker + Ollama Installer log',
        (Format-LogField 'Started' $Fields.Started),
        (Format-LogField 'Source' $Fields.Source),
        (Format-LogField 'System' $Fields.System),
        (Format-LogField 'Options' $Fields.Options),
        (Format-LogField 'Log file' $Fields.LogFile),
        $script:LogRule
    )
    return (@($lines | ForEach-Object { Protect-LogText $_ }) -join "`n")
}

function Format-TimelineLine([string]$Time, [string]$Level, [string]$Step, [string]$Message) {
    # Columns: time, level, step, message. Continuation lines are indented under the message.
    $lines = @("$Message" -split '\r?\n' | ForEach-Object { $_.TrimEnd() })
    $out = @("$Time  $($Level.PadRight(5))  $($Step.PadRight(8)) $($lines[0])")
    foreach ($l in ($lines | Select-Object -Skip 1)) { if ($l.Trim()) { $out += "$(' ' * 30)| $l" } }
    return (@($out | ForEach-Object { Protect-LogText $_ }) -join "`n")
}

function Format-Duration([double]$Ms) {
    $total = [int][math]::Floor([math]::Max(0, $Ms) / 1000)
    $m = [int][math]::Floor($total / 60)
    $s = $total % 60
    if ($m -gt 0) { return "${m}m${s}s" }
    return "${s}s"
}

function Get-LogPairs($Map) {
    # Key/value pairs from an ordered hashtable or a JSON object, in order.
    if ($Map -is [System.Collections.IDictionary]) { foreach ($k in $Map.Keys) { [pscustomobject]@{ Key = "$k"; Value = "$($Map[$k])" } } }
    elseif ($null -ne $Map) { foreach ($p in $Map.PSObject.Properties) { [pscustomobject]@{ Key = "$($p.Name)"; Value = "$($p.Value)" } } }
}

function Format-Summary($Results, $Notes, [int]$ExitCode, [double]$DurationMs, [bool]$Cancelled) {
    $head = " SUMMARY   exit code $ExitCode   (duration $(Format-Duration $DurationMs))"
    if ($Cancelled) { $head += '   cancelled' }
    $lines = @($script:LogRule, $head)
    foreach ($pair in @(Get-LogPairs $Results)) { $lines += "   $($pair.Key.PadRight(8)) $(($pair.Value -split '\r?\n')[0])" }
    $noteList = @(@($Notes) | Where-Object { $_ })
    if ($noteList.Count -gt 0) {
        $lines += ' Next steps:'
        foreach ($n in $noteList) { $lines += "   - $n" }
    }
    return (@($lines | ForEach-Object { Protect-LogText $_ }) -join "`n")
}

function Format-RunEnd($Results, $Notes, [int]$ExitCode, [double]$DurationMs, [bool]$Cancelled, $Reports) {
    # foreach instead of @($Reports): PowerShell 7.6 throws "Argument types do not match" for
    # @() around a List[object] of PSCustomObjects.
    $reportList = New-Object System.Collections.Generic.List[object]
    foreach ($r in $Reports) { if ($null -ne $r) { $reportList.Add($r) } }
    $parts = @(Format-Summary $Results $Notes $ExitCode $DurationMs $Cancelled)
    for ($i = 0; $i -lt $reportList.Count; $i++) { $parts += Format-FailureReport $reportList[$i] ($i + 1) $reportList.Count }
    $parts += $script:LogRule
    return ($parts -join "`n")
}

function Add-LogText([string]$Text) {
    # Never throws: a broken log must not break the install.
    if (-not $script:LogFile) { return }
    try { [System.IO.File]::AppendAllText($script:LogFile, "$Text`n", $script:Utf8NoBom) }
    catch {
        if (-not $script:LogWarned) {
            $script:LogWarned = $true
            Write-Host "    [warn] Could not write the log file $($script:LogFile): $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
}

function Write-InstallLog([string]$Level, [string]$Message, [string]$Step = $script:LogStep) {
    if (-not $script:LogFile) { return }
    try { Add-LogText (Format-TimelineLine (Get-Date).ToString('HH:mm:ss.fff') $Level $Step "$script:LogTag$Message") } catch { }
}

function Get-DefaultLogDir {
    # Same folder as the desktop app (Electron's app.getPath('logs')), so all logs are in one place.
    $name = 'Docker + Ollama Installer'
    if ($script:OnWindows) {
        $base = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $HOME 'AppData\Roaming' }
        return (Join-Path (Join-Path $base $name) 'logs')
    }
    if ($script:OnMac) { return (Join-Path (Join-Path $HOME 'Library/Logs') $name) }
    $config = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $HOME '.config' }
    return (Join-Path (Join-Path $config $name) 'logs')
}

function Remove-OldLogs([string]$Dir, [int]$Keep = $script:LogsToKeep) {
    try {
        Get-ChildItem -LiteralPath $Dir -File -ErrorAction Stop |
            Where-Object { $_.Name -match '^(install|crash)-.*\.log$' } |
            Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep |
            Remove-Item -Force -ErrorAction SilentlyContinue -WhatIf:$false -Confirm:$false
    } catch { }
}

function Get-LogSystem {
    $name = 'unknown OS'
    try {
        if ($script:OnWindows) {
            $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
            $name = "$($os.Caption) ($($os.Version))"
        } elseif ($script:OnMac) {
            $name = "macOS $("$(& sw_vers -productVersion)".Trim())"
        } else {
            $rel = Get-OsRelease
            $name = if ($rel['PRETTY_NAME']) { $rel['PRETTY_NAME'] } else { "Linux $(& uname -r)" }
        }
    } catch { }
    $arch = try { Get-Arch } catch { 'unknown' }
    $admin = $false
    try {
        if ($script:OnWindows) {
            $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
            $admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        } else { $admin = Test-IsRoot }
    } catch { }
    return "$name ($arch)   user: $([Environment]::UserName)   admin: $(if ($admin) { 'yes' } else { 'no' })"
}

function Get-LogOptions {
    $yn = { param($b) if ($b) { 'yes' } else { 'no' } }
    $modelText = if ($script:SkipModels) { 'none' }
                 elseif ($script:ScriptBoundParameters.ContainsKey('Models')) { if ($Models.Count) { $Models -join ',' } else { 'none' } }
                 else { 'ask' }
    return "ollama=$(& $yn (-not $script:SkipOllama))  models=$modelText  docker=$(& $yn (-not $script:SkipDocker))  engine=$(& $yn $script:DockerEngine)  dry-run=$(& $yn $WhatIfPreference)"
}

function Initialize-Log {
    try {
        if ($LogPath) {
            $script:LogFile = [System.IO.Path]::GetFullPath($LogPath)
        } else {
            $dir = Get-DefaultLogDir
            [void][System.IO.Directory]::CreateDirectory($dir)
            Remove-OldLogs $dir
            $script:LogFile = Join-Path $dir ('install-cli-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
        }
        [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $script:LogFile))
    } catch {
        $script:LogFile = $null
        Write-Warn "Could not create a log file: $($_.Exception.Message)"
        return
    }
    if ($ResultFile) {
        # Elevated Docker process: append to the parent's log.
        $script:LogTag = '[elevated] '
        Write-InstallLog 'INFO' "Elevated process started (PID $PID)"
        return
    }
    Add-LogText (Format-LogHeader @{
        Started = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')
        Source  = "install.ps1 (PowerShell $($PSVersionTable.PSVersion))"
        System  = Get-LogSystem
        Options = Get-LogOptions
        LogFile = $script:LogFile
    })
}

function Add-Failure([string]$Step, $ErrorRecord) {
    # Records a failure: one ERROR line now, the full report at the end of the log.
    try { $report = ConvertTo-ErrorReport -Step $Step -ErrorRecord $ErrorRecord }
    catch { $report = New-ErrorReport -Step $Step -Message "$ErrorRecord" }
    $script:Failures.Add($report)
    $line = if ($report.Hint) { "$($report.Summary)`nHint: $($report.Hint)" } else { $report.Summary }
    Write-InstallLog 'ERROR' $line ($Step -split ':')[0]
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
    # Runs an external command, shows and logs its output, and throws if it exits non-zero. The
    # exception carries the command, exit code and last output lines for the failure report.
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [int[]]$AllowedExitCodes = @(0)
    )
    $display = (@($FilePath) + $ArgumentList) -join ' '
    if (-not (Confirm-Action $display 'Run')) { return }
    Write-InstallLog 'INFO' "Running: $display"
    $tail = New-Object System.Collections.Generic.List[string]
    $trace = @{ Command = $null; ExitCode = $null }
    $oldEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'   # 5.1 turns redirected native stderr into errors
    try {
        # Write-Host keeps command output on screen instead of leaking into function return values.
        & $FilePath @ArgumentList 2>&1 | ForEach-Object {
            $line = "$_"
            if ($line -match '^@+CMD (.*)$') {          # traced command in a root script
                $trace.Command = $Matches[1]
                if ($Matches[1] -match '^echo\b') { return }
                $line = "`$ $($Matches[1])"
            } elseif ($line -match '^@@ERROR-EXIT (-?\d+)') {
                $trace.ExitCode = [int]$Matches[1]
                return
            }
            Write-Host $line
            # Progress bars redraw with `r or ESC[<n>G (cursor to column): keep the final frame
            # and drop colour codes.
            $frames = ($line -replace '\x1b\[\d*G', "`r") -split "`r" | ForEach-Object { $_ -replace '\x1b\[[0-9;?]*[A-Za-z]', '' }
            $clean = $frames | Where-Object { $_.Trim() } | Select-Object -Last 1
            if ($clean -and $clean.Trim()) {
                Write-InstallLog 'OUT' $clean
                $tail.Add($clean.TrimEnd())
                if ($tail.Count -gt 40) { $tail.RemoveAt(0) }
            }
        }
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $oldEap }
    if ($AllowedExitCodes -notcontains $code) {
        $ex = New-Object System.Exception ("Command failed (exit code $code): $display")
        $failedCommand = $display
        if ($null -ne $trace.ExitCode -and $trace.Command) { $failedCommand = $trace.Command; $code = $trace.ExitCode }
        $ex.Data['Command']  = $failedCommand
        $ex.Data['ExitCode'] = $code
        $ex.Data['Output']   = $tail.ToArray()
        if ($FilePath -eq 'sudo') { $ex.Data['Elevated'] = 'sudo' }
        elseif (Test-IsRoot) { $ex.Data['Elevated'] = 'root' }
        throw $ex
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

function Get-WindowsAccountName {
    # DOMAIN\user, so domain accounts can be added to local groups.
    if ($env:USERDOMAIN -and $env:USERNAME) { return "$env:USERDOMAIN\$env:USERNAME" }
    return $env:USERNAME
}

function Get-TargetUser {
    if ($script:OnWindows) {
        if ($InvokingUser) { return $InvokingUser }
        return Get-WindowsAccountName
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
        return ConvertTo-Round1 ($bytes / 1GB)
    } catch { return $null }
}

function ConvertTo-Round1([double]$Value) {
    # Half away from zero, matching Math.round() in the Electron app (PowerShell defaults to banker's rounding).
    return [math]::Round($Value, 1, [MidpointRounding]::AwayFromZero)
}

function ConvertFrom-NvidiaSmi($Lines) {
    # nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits prints MiB per GPU.
    $mib = @($Lines | ForEach-Object { "$_".Trim() } | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [double]$_ })
    if ($mib.Count -eq 0) { return $null }
    return ConvertTo-Round1 (($mib | Measure-Object -Maximum).Maximum / 1024)
}

function ConvertFrom-RocmSmiJson([string]$Json) {
    # rocm-smi --showmeminfo vram --json: { "card0": { "VRAM Total Memory (B)": "17163091968", ... } }
    try { $data = $Json | ConvertFrom-Json } catch { return $null }
    if (-not $data) { return $null }
    $inv = [Globalization.CultureInfo]::InvariantCulture
    $sizes = @(foreach ($card in $data.PSObject.Properties) {
        if ($card.Value -isnot [System.Management.Automation.PSCustomObject]) { continue }
        foreach ($p in $card.Value.PSObject.Properties) {
            $bytes = 0.0
            if ($p.Name -match 'vram.*total' -and
                [double]::TryParse("$($p.Value)", [Globalization.NumberStyles]::Float, $inv, [ref]$bytes) -and $bytes -gt 0) {
                $bytes / 1GB
            }
        }
    })
    if ($sizes.Count -eq 0) { return $null }
    return ConvertTo-Round1 ($sizes | Measure-Object -Maximum).Maximum
}

function Get-GpuInfo {
    # NVIDIA (nvidia-smi), then AMD (rocm-smi). Returns @{ Vendor; VramGB } or $null.
    # Win32_VideoController.AdapterRAM is a 32-bit value capped at 4 GB, so it is not used.
    $oldEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
        if ($smi) {
            $out = & $smi.Source --query-gpu=memory.total --format=csv,noheader,nounits 2>$null
            if ($LASTEXITCODE -eq 0) {
                $vram = ConvertFrom-NvidiaSmi $out
                if ($vram) { return @{ Vendor = 'NVIDIA'; VramGB = $vram } }
            }
        }
        $rocm = Get-Command rocm-smi -ErrorAction SilentlyContinue
        if ($rocm) {
            $out = & $rocm.Source --showmeminfo vram --json 2>$null
            if ($LASTEXITCODE -eq 0) {
                $vram = ConvertFrom-RocmSmiJson (@($out) -join "`n")
                if ($vram) { return @{ Vendor = 'AMD'; VramGB = $vram } }
            }
        }
        return $null
    } catch { return $null }
    finally { $ErrorActionPreference = $oldEap }
}

function ConvertTo-ModelBudget($RamGB, $Gpu, [bool]$AppleSilicon) {
    # Memory (GB) a model can use and still run fast. Same rules as computeModelBudget() in the app.
    if ($Gpu) {
        return @{ Budget = $Gpu.VramGB; Ram = $RamGB; Source = "$($Gpu.Vendor) GPU with $($Gpu.VramGB) GB VRAM" }
    }
    if (-not $RamGB) { return $null }
    if ($AppleSilicon) {
        # Metal can use about 2/3 of unified memory by default.
        return @{ Budget = (ConvertTo-Round1 ($RamGB * 0.65)); Ram = $RamGB; Source = "Apple silicon with $RamGB GB unified memory" }
    }
    # CPU inference: leave half the RAM for the OS, Docker and other apps.
    return @{ Budget = (ConvertTo-Round1 ($RamGB * 0.5)); Ram = $RamGB; Source = "CPU with $RamGB GB RAM" }
}

function Get-ModelBudget {
    $appleSilicon = $script:OnMac -and (Get-Arch) -eq 'arm64'
    return ConvertTo-ModelBudget (Get-SystemMemoryGB) (Get-GpuInfo) $appleSilicon
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
                    $installed[(ConvertTo-ModelKey $m.name)] = @{ Name = "$($m.name)"; Size = (ConvertTo-Round1 ([double]$m.size / 1GB)) }
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
                if ($bytes) { $size = ConvertTo-Round1 ($bytes / 1GB) }
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

function Get-ModelRows($Catalog, [hashtable]$Installed, $Budget) {
    # Builds the model table: catalog entries sorted by size, then downloaded models that aren't
    # in the catalog. Default: the largest recommended catalog model, else the first row.
    # Same rules as buildModelRows() in the app (tests/fixtures/model-rows.parity.json keeps them in sync).
    if (-not $Installed) { $Installed = @{} }
    $catalog = @($Catalog | Sort-Object { [double]$_.size_gb }, name)
    $catalogKeys = @($catalog | ForEach-Object { ConvertTo-ModelKey $_.name })
    $extras = @($Installed.Keys | Where-Object { $catalogKeys -notcontains $_ } | ForEach-Object {
        $name = $Installed[$_].Name -replace ':latest$', ''
        [pscustomobject]@{ name = $name; description = 'Downloaded earlier (not in models.json)'; size_gb = $Installed[$_].Size }
    } | Sort-Object { [double]$_.size_gb }, name)

    $all  = @($catalog) + @($extras)
    $rows = @(for ($i = 0; $i -lt $all.Count; $i++) {
        $m = $all[$i]
        [pscustomobject]@{
            Index       = $i + 1
            Name        = "$($m.name)"
            Size        = $m.size_gb
            Tier        = Get-ModelTier $m $Budget
            Installed   = $Installed.ContainsKey((ConvertTo-ModelKey $m.name))
            Description = "$($m.description)"
        }
    })

    $recommended = @($rows | Where-Object { $_.Index -le $catalog.Count -and $_.Tier -eq 'recommended' })
    $default = if ($recommended.Count -gt 0) { $recommended[-1] } elseif ($rows.Count -gt 0) { $rows[0] } else { $null }
    return @{ Rows = $rows; Default = $default }
}

function Select-Models {
    $path = $ModelsFile
    if (-not $path -and $PSScriptRoot) { $path = Join-Path $PSScriptRoot 'models.json' }

    Write-Step 'Choose Ollama models'
    $catalog = @(Get-ModelCatalog $path)
    $budget  = Get-ModelBudget
    if ($budget) {
        Write-Info "Detected: $($budget.Source). Recommending models that need up to $($budget.Budget) GB."
    } else {
        Write-Warn 'Could not detect system memory; no models are marked recommended.'
    }

    $installed = Get-InstalledModels
    if ($installed.Count -gt 0) { Write-Info "Already downloaded: $($installed.Count) model(s)." }

    $table   = Get-ModelRows $catalog $installed $budget
    $rows    = $table.Rows
    $default = $table.Default

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
    # Per-run directory: a fixed name in a shared temp folder could be pre-created as a symlink.
    $log = Join-Path (New-TempDir) 'ollama-serve.log'
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
            Add-Failure "Models: $m" $_
            $failed += $m
        }
    }
    if ($WhatIfPreference) { return 'would pull' }
    if ($failed.Count -gt 0) {
        $ex = New-Object System.Exception ("Failed to pull: $($failed -join ', ')")
        $ex.Data['Reported'] = $true   # each model already has its own failure report
        throw $ex
    }
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

function Add-DockerUsersMember([string]$User) {
    # Add-LocalGroupMember tells "already a member" apart from real errors; net.exe exits 2 for both.
    if (-not (Confirm-Action 'docker-users' "Add $User to the local group")) { return }
    try {
        Add-LocalGroupMember -Group 'docker-users' -Member $User -ErrorAction Stop
        Write-Ok "Added $User to docker-users"
        Add-Note ('Sign out and back in (or reboot) so the docker-users group membership takes effect, then start Docker Desktop.')
    } catch {
        if ("$($_.FullyQualifiedErrorId) $($_.Exception.Message)" -match 'MemberExists|already a member') {
            Write-Ok "$User is already in docker-users"
        } else {
            Write-Warn "Could not add $User to docker-users: $($_.Exception.Message)"
            Add-Note ("Ask an administrator to add $User to the local 'docker-users' group.")
        }
    }
}

function Install-DockerWindows {
    # wsl.exe prints UTF-16 unless asked for UTF-8, which shows up as spaced-out text.
    $env:WSL_UTF8 = '1'
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
        Add-Note ('Reboot Windows to finish the WSL2 install before starting Docker Desktop.')
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

    Add-DockerUsersMember (Get-TargetUser)
    Update-SessionPath
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
    Add-Note ('Open Docker Desktop once (/Applications/Docker.app) to finish setup.')
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
        [System.IO.File]::WriteAllText($file, ("$script:ShPreamble`n$Script" -replace "`r`n", "`n"))
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
        Add-Note ("Log out and back in so '$user' can run docker without sudo.")
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
        Add-Note ('Start Docker Desktop from your applications menu (or: systemctl --user start docker-desktop).')
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
    if ($script:LogFile -and -not $ResultFile) { Write-Host "Log: $($script:LogFile)" -ForegroundColor DarkGray }

    # Ask which models to pull before anything is installed, so the rest runs unattended.
    if (-not $script:SkipModels -and -not $script:ScriptBoundParameters.ContainsKey('Models')) {
        $script:Models = @(Select-Models)
        if ($script:Models.Count -eq 0) { $script:SkipModels = [switch]$true }
        Write-InstallLog 'INFO' "Models selected: $(if ($script:Models.Count) { $script:Models -join ', ' } else { 'none' })"
    }

    $steps = @(
        @{ Name = 'Ollama';  Skip = [bool]$script:SkipOllama; Action = { Install-Ollama } },
        @{ Name = 'Models';  Skip = [bool]$script:SkipModels; Action = { Invoke-ModelPull } },
        @{ Name = 'Docker';  Skip = [bool]$script:SkipDocker; Action = { Install-Docker } }
    )

    # Windows: only WSL/Docker need admin. Ollama installs per user, so it and the model pulls run
    # here, as the signed-in user, and only the Docker step is re-launched elevated. (Elevating
    # everything would install Ollama into the admin's profile when someone else types the admin
    # password.) Skipped for -WhatIf dry runs.
    $elevateDocker = $false
    if ($script:OnWindows -and -not $WhatIfPreference -and -not $script:SkipDocker) {
        $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
        $elevateDocker = -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        if ($elevateDocker -and -not $PSCommandPath) {
            throw 'Self-elevation on Windows requires running install.ps1 from a file. Save the script locally or run from an elevated PowerShell.'
        }
    }

    foreach ($step in $steps) {
        $script:LogStep = $step.Name
        if ($step.Skip) { $script:Results[$step.Name] = 'skipped'; Write-InstallLog 'STEP' 'skipped'; continue }
        Write-InstallLog 'STEP' 'running'
        if ($elevateDocker -and $step.Name -eq 'Docker') {
            $script:Results['Docker'] = Invoke-ElevatedDockerStep
        } else {
            try {
                $out = & $step.Action
                $script:Results[$step.Name] = "$(@($out)[-1])"
            } catch {
                Write-Warn "$($step.Name) failed: $($_.Exception.Message)"
                $summary = $_.Exception.Message
                if (-not $_.Exception.Data['Reported']) {
                    Add-Failure $step.Name $_
                    $summary = $script:Failures[$script:Failures.Count - 1].Summary
                }
                $script:Results[$step.Name] = "FAILED: $summary"
            }
        }
        $result = $script:Results[$step.Name]
        if ($result -like 'FAILED*') { Write-InstallLog 'STEP' ('failed: ' + ($result -replace '^FAILED:\s*', '')) }
        else { Write-InstallLog 'STEP' "done: $result" }
    }

    if ($ResultFile) {
        # Running elevated on behalf of a non-admin console: hand the results back to it.
        @{ Results = $script:Results; Notes = @($script:Notes); Failures = $script:Failures.ToArray() } | ConvertTo-Json -Depth 6 |
            Set-Content -LiteralPath $ResultFile -Encoding UTF8 -WhatIf:$false
        $failedSteps = @($script:Results.Values | Where-Object { $_ -like 'FAILED*' })
        if ($failedSteps.Count -gt 0) { exit 1 }
        exit 0
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
    $exitCode = if ($failedSteps.Count -gt 0) { 1 } else { 0 }
    Write-FailureSummary
    Add-LogText (Format-RunEnd $script:Results @($script:Notes | Select-Object -Unique) $exitCode `
        ((Get-Date) - $script:LogStarted).TotalMilliseconds $false $script:Failures)
    if ($script:LogFile) { Write-Host "`n    Full log: $($script:LogFile)" -ForegroundColor DarkGray }
    exit $exitCode
}

function Write-FailureSummary {
    # Short console version of the failure reports; the full ones are in the log file.
    if ($script:Failures.Count -eq 0) { return }
    Write-Host "`n    What went wrong:" -ForegroundColor Red
    foreach ($f in $script:Failures) {
        Write-Host "     - $($f.Step): $($f.Summary)" -ForegroundColor Red
        if ($f.Command) { Write-Host "         Command: $(Protect-LogText $f.Command)" }
        if ($f.Hint)    { Write-Host "         Hint: $($f.Hint)" -ForegroundColor Yellow }
        $last = @(@($f.Output) | Where-Object { $_ } | Select-Object -Last 3)
        foreach ($l in $last) { Write-Host "         | $(Protect-LogText $l)" -ForegroundColor DarkGray }
    }
}

function Invoke-ElevatedDockerStep {
    # Re-launches this script elevated for the Docker step only and returns its result. The
    # elevated process writes its results and notes to a file, so the summary appears here.
    Write-Step 'Docker'
    Write-Info 'Docker Desktop needs administrator rights; approve the Windows prompt to continue.'
    $tmp = New-TempDir
    $resultPath = Join-Path $tmp 'result.json'
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
                 '-SkipOllama', '-SkipModels',
                 '-InvokingUser', "`"$(Get-WindowsAccountName)`"",
                 '-InvokingProfile', "`"$env:USERPROFILE`"",
                 '-ResultFile', "`"$resultPath`"")
    if ($script:DockerEngine) { $argList += '-DockerEngine' }
    if ($script:LogFile) { $argList += @('-LogPath', "`"$($script:LogFile)`"") }   # child appends to this log
    try {
        $hostExe = (Get-Process -Id $PID).Path
        try {
            $p = Start-Process -FilePath $hostExe -ArgumentList $argList -Verb RunAs -Wait -PassThru
        } catch {
            Add-Failure 'Docker' $_
            return "FAILED: could not start the elevated installer ($($_.Exception.Message))"
        }
        if (-not (Test-Path -LiteralPath $resultPath)) {
            $msg = "The elevated installer exited with code $($p.ExitCode) without reporting a result"
            $script:Failures.Add((New-ErrorReport -Step 'Docker' -Message $msg -Elevated 'uac'))
            Write-InstallLog 'ERROR' $msg
            return "FAILED: $msg"
        }
        $report = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
        foreach ($n in @($report.Notes)) { if ($n) { $script:Notes.Add("$n") } }
        foreach ($f in @($report.Failures)) { if ($f) { $script:Failures.Add($f) } }
        $docker = "$($report.Results.Docker)"
        if ($docker -like 'FAILED*') { Write-Warn "Docker $docker" } elseif ($docker) { Write-Ok $docker }
        if ($docker) { return $docker }
        return 'FAILED: no Docker result'
    } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue -WhatIf:$false }
}

if ($MyInvocation.InvocationName -ne '.') {
    Initialize-Log
    try {
        Invoke-Main
    } catch {
        # Anything that escapes the steps (an unsupported OS, the model picker, a bug) still
        # gets a full report in the log.
        Add-Failure 'FATAL' $_
        $fatal = $script:Failures[$script:Failures.Count - 1]
        Write-Host "`nThe installer stopped: $($fatal.Summary)" -ForegroundColor Red
        if ($fatal.Hint) { Write-Host "Hint: $($fatal.Hint)" -ForegroundColor Yellow }
        if ($ResultFile) {
            @{ Results = @{ Docker = "FAILED: $($fatal.Summary)" }; Notes = @($script:Notes); Failures = $script:Failures.ToArray() } |
                ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ResultFile -Encoding UTF8 -WhatIf:$false
        } else {
            Add-LogText (Format-RunEnd $script:Results @($script:Notes) 1 ((Get-Date) - $script:LogStarted).TotalMilliseconds $false $script:Failures)
            if ($script:LogFile) { Write-Host "Full log: $($script:LogFile)" -ForegroundColor DarkGray }
        }
        exit 1
    }
}
