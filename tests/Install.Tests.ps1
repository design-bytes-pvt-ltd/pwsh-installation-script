BeforeAll {
    $script:RepoRoot = Split-Path -Parent $PSScriptRoot
    . (Join-Path $script:RepoRoot 'install.ps1')
}

Describe 'ConvertTo-Selection' {
    It 'parses single numbers and ranges into 0-based indexes' {
        (ConvertTo-Selection '1,3 5-7' 10) | Should -Be @(0, 2, 4, 5, 6)
    }

    It 'deduplicates overlapping numbers' {
        (ConvertTo-Selection '2,2-4,3' 5) | Should -Be @(1, 2, 3)
    }

    It 'returns $null for out-of-range or invalid tokens' {
        ConvertTo-Selection '0,1' 5 | Should -BeNullOrEmpty
        ConvertTo-Selection '1,6' 5 | Should -BeNullOrEmpty
        ConvertTo-Selection '4-2' 5 | Should -BeNullOrEmpty
        ConvertTo-Selection 'foo' 5 | Should -BeNullOrEmpty
        ConvertTo-Selection '   ' 5 | Should -BeNullOrEmpty
    }
}

Describe 'ConvertTo-ModelKey' {
    It 'normalizes implicit :latest and registry prefixes' {
        ConvertTo-ModelKey 'phi4-mini' | Should -Be 'phi4-mini:latest'
        ConvertTo-ModelKey 'phi4-mini:latest' | Should -Be 'phi4-mini:latest'
        ConvertTo-ModelKey 'library/phi4-mini:latest' | Should -Be 'phi4-mini:latest'
        ConvertTo-ModelKey 'registry.ollama.ai/library/phi4-mini:latest' | Should -Be 'phi4-mini:latest'
        ConvertTo-ModelKey '  Qwen3:8B  ' | Should -Be 'qwen3:8b'
    }
}

Describe 'Get-ModelMinMemory and Get-ModelTier' {
    It 'uses explicit min_memory_gb when provided' {
        $m = [pscustomobject]@{ name = 'test'; size_gb = 4.0; min_memory_gb = 7 }
        Get-ModelMinMemory $m | Should -Be 7
    }

    It 'estimates min_memory_gb from size_gb when omitted' {
        $m = [pscustomobject]@{ name = 'test'; size_gb = 4.0 }
        Get-ModelMinMemory $m | Should -Be 6
    }

    It 'classifies tiers against budget and RAM' {
        $budget = @{ Budget = 8.0; Ram = 16.0 }
        Get-ModelTier ([pscustomobject]@{ min_memory_gb = 8 }) $budget | Should -Be 'recommended'
        Get-ModelTier ([pscustomobject]@{ min_memory_gb = 12 }) $budget | Should -Be 'may be slow'
        Get-ModelTier ([pscustomobject]@{ min_memory_gb = 20 }) $budget | Should -Be 'too large'
    }
}

Describe 'Get-ModelCatalog' {
    It 'loads valid models.json entries' {
        $models = @(Get-ModelCatalog (Join-Path $script:RepoRoot 'models.json'))
        $models.Count | Should -BeGreaterThan 0
        $models[0].name | Should -Not -BeNullOrEmpty
    }

    It 'falls back to built-in default when file is missing or invalid' {
        $missing = @(Get-ModelCatalog (Join-Path $TestDrive 'missing.json'))
        $missing.Count | Should -Be 1
        $missing[0].name | Should -Be 'qwen3:0.6b'

        $badPath = Join-Path $TestDrive 'bad.json'
        Set-Content -Path $badPath -Value '{invalid json'
        $bad = @(Get-ModelCatalog $badPath)
        $bad.Count | Should -Be 1
        $bad[0].name | Should -Be 'qwen3:0.6b'
    }
}

Describe 'Get-OllamaBaseUrl' {
    BeforeEach { $script:PrevHost = $env:OLLAMA_HOST }
    AfterEach  { $env:OLLAMA_HOST = $script:PrevHost }

    It 'defaults to http://127.0.0.1:11434 when OLLAMA_HOST is unset' {
        $env:OLLAMA_HOST = ''
        Get-OllamaBaseUrl | Should -Be 'http://127.0.0.1:11434'
    }

    It 'normalizes 0.0.0.0 and missing scheme/port' {
        $env:OLLAMA_HOST = '0.0.0.0:11434'
        Get-OllamaBaseUrl | Should -Be 'http://127.0.0.1:11434'

        $env:OLLAMA_HOST = '10.0.0.5'
        Get-OllamaBaseUrl | Should -Be 'http://10.0.0.5:11434'

        $env:OLLAMA_HOST = 'https://ollama.internal:8443'
        Get-OllamaBaseUrl | Should -Be 'https://ollama.internal:8443'
    }
}

Describe 'Parity with the Electron app (tests/fixtures/model-rows.parity.json)' {
    BeforeDiscovery {
        $fixture = Get-Content (Join-Path (Split-Path -Parent $PSScriptRoot) 'tests/fixtures/model-rows.parity.json') -Raw | ConvertFrom-Json
        $script:RowCases    = @($fixture.rowCases | ForEach-Object { @{ Case = $_ } })
        $script:BudgetCases = @($fixture.budgetCases | ForEach-Object { @{ Case = $_ } })
    }

    BeforeAll {
        $script:Fixture = Get-Content (Join-Path $script:RepoRoot 'tests/fixtures/model-rows.parity.json') -Raw | ConvertFrom-Json
        $script:Installed = @{}
        foreach ($m in $script:Fixture.installed) { $script:Installed[$m.key] = @{ Name = $m.name; Size = $m.sizeGB } }
    }

    It 'builds the same rows: <Case.label>' -ForEach $script:RowCases {
        $budget = if ($Case.budget) { @{ Budget = [double]$Case.budget.budgetGB; Ram = [double]$Case.budget.ramGB } } else { $null }
        $table = Get-ModelRows $script:Fixture.catalog $script:Installed $budget
        @($table.Rows | ForEach-Object { $_.Name }) | Should -Be @($script:Fixture.rowOrder)
        @($table.Rows | ForEach-Object { $_.Tier }) | Should -Be @($Case.tiers)
        $table.Default.Name | Should -Be $Case.default
        @($table.Rows | Where-Object { $_.Installed } | ForEach-Object { $_.Name }) | Should -Be @($script:Fixture.installedNames)
    }

    It 'computes the same budget: ram=<Case.ramGB> apple=<Case.appleSilicon>' -ForEach $script:BudgetCases {
        $gpu = if ($Case.gpu) { @{ Vendor = $Case.gpu.vendor; VramGB = [double]$Case.gpu.vramGB } } else { $null }
        $ram = if ($null -ne $Case.ramGB) { [double]$Case.ramGB } else { $null }
        $budget = ConvertTo-ModelBudget $ram $gpu ([bool]$Case.appleSilicon)
        if ($null -eq $Case.expected) {
            $budget | Should -BeNullOrEmpty
        } else {
            $budget.Budget | Should -Be ([double]$Case.expected.budgetGB)
            $budget.Source | Should -Be $Case.expected.source
        }
    }

    It 'parses GPU tool output the same way' {
        ConvertFrom-NvidiaSmi ($script:Fixture.gpuParsing.nvidiaSmi.output -split "`n") | Should -Be $script:Fixture.gpuParsing.nvidiaSmi.expectedGB
        ConvertFrom-RocmSmiJson $script:Fixture.gpuParsing.rocmSmi.output | Should -Be $script:Fixture.gpuParsing.rocmSmi.expectedGB
    }
}

Describe 'Failure log parity with the Electron app (tests/fixtures/error-report.parity.json)' {
    BeforeDiscovery {
        $fixture = Get-Content (Join-Path (Split-Path -Parent $PSScriptRoot) 'tests/fixtures/error-report.parity.json') -Raw | ConvertFrom-Json
        $script:ReportCases = @($fixture.reportCases | ForEach-Object { @{ Case = $_ } })
    }

    BeforeAll {
        $script:Fixture = Get-Content (Join-Path $script:RepoRoot 'tests/fixtures/error-report.parity.json') -Raw | ConvertFrom-Json
        function ConvertTo-ReportParams($Fields) {
            $p = @{ Step = $Fields.step; Message = $Fields.message }
            foreach ($k in 'command', 'exitCode', 'elevated', 'where', 'output', 'details') {
                if ($null -ne $Fields.$k) { $p[$k.Substring(0, 1).ToUpper() + $k.Substring(1)] = $Fields.$k }
            }
            return $p
        }
    }

    It 'uses the same hint table' {
        $script:ErrorHints.Count | Should -Be @($script:Fixture.hints).Count
        for ($i = 0; $i -lt $script:ErrorHints.Count; $i++) {
            $h = $script:ErrorHints[$i]; $f = @($script:Fixture.hints)[$i]
            $h.Id | Should -BeExactly $f.id
            $h.Pattern | Should -BeExactly $f.pattern
            $h.Text | Should -BeExactly $f.text
            @($h.ExitCodes) | Should -Be @($f.exitCodes)
        }
    }

    It 'writes the same report: <Case.label>' -ForEach $script:ReportCases {
        $params = ConvertTo-ReportParams $Case.input
        $report = New-ErrorReport @params
        $report.HintId | Should -Be $Case.hintId
        Format-FailureReport $report $Case.index $Case.total | Should -BeExactly $Case.expected
    }

    It 'redacts secrets the same way' {
        foreach ($c in $script:Fixture.redactCases) { Protect-LogText $c.input | Should -BeExactly $c.expected }
    }

    It 'formats timeline lines the same way' {
        foreach ($c in $script:Fixture.timelineCases) {
            Format-TimelineLine $c.time $c.level $c.step $c.message | Should -BeExactly $c.expected
        }
    }

    It 'formats durations the same way' {
        foreach ($c in $script:Fixture.durationCases) { Format-Duration $c.ms | Should -BeExactly $c.expected }
    }

    It 'formats the summary, run end and header the same way' {
        $s = $script:Fixture.summaryCase.input
        Format-Summary $s.results $s.notes $s.exitCode $s.durationMs $s.cancelled | Should -BeExactly $script:Fixture.summaryCase.expected
        $c = $script:Fixture.cancelledSummaryCase.input
        Format-Summary $c.results $c.notes $c.exitCode $c.durationMs $c.cancelled | Should -BeExactly $script:Fixture.cancelledSummaryCase.expected
        $e = $script:Fixture.runEndCase
        $reports = @($e.reports | ForEach-Object { $p = ConvertTo-ReportParams $_; New-ErrorReport @p })
        Format-RunEnd $e.summary.results $e.summary.notes $e.summary.exitCode $e.summary.durationMs $e.summary.cancelled $reports |
            Should -BeExactly $e.expected
        $h = $script:Fixture.headerCase.input
        Format-LogHeader @{ Started = $h.started; Source = $h.source; System = $h.system; Options = $h.options; LogFile = $h.logFile } |
            Should -BeExactly $script:Fixture.headerCase.expected
    }
}

Describe 'Failure capture' {
    BeforeAll {
        Mock Confirm-Action { $true }
        $script:LogFile = $null
    }

    It 'Invoke-Native attaches the command, exit code and output to the error' -Skip:($IsWindows) {
        $err = $null
        try { Invoke-Native -FilePath 'sh' -ArgumentList @('-c', 'echo first; echo second >&2; exit 3') 6>$null }
        catch { $err = $_ }
        $err | Should -Not -BeNullOrEmpty
        $err.Exception.Data['ExitCode'] | Should -Be 3
        $err.Exception.Data['Command'] | Should -Be 'sh -c echo first; echo second >&2; exit 3'
        @($err.Exception.Data['Output']) | Should -Contain 'first'
        @($err.Exception.Data['Output']) | Should -Contain 'second'

        $report = ConvertTo-ErrorReport -Step 'Docker' -ErrorRecord $err
        $report.Summary | Should -Be 'Command failed (exit code 3)'
        $report.ExitCode | Should -Be 3
        $report.Details | Should -Contain 'PowerShell stack:'
    }

    It 'names the failing command inside a traced root script' -Skip:($IsWindows) {
        $file = Join-Path ([IO.Path]::GetTempPath()) "trace-$([guid]::NewGuid().ToString('N')).sh"
        [IO.File]::WriteAllText($file, ("$script:ShPreamble`necho hello`nls /nonexistent-dir-xyz`necho never`n" -replace "`r`n", "`n"))
        try {
            $err = $null
            try { Invoke-Native -FilePath 'sh' -ArgumentList @($file) 6>$null } catch { $err = $_ }
            $err.Exception.Data['Command'] | Should -Be 'ls /nonexistent-dir-xyz'
            $err.Exception.Data['ExitCode'] | Should -BeGreaterThan 0
            @($err.Exception.Data['Output']) | Should -Contain '$ ls /nonexistent-dir-xyz'
            @($err.Exception.Data['Output']) | Should -Not -Contain 'never'
        } finally { Remove-Item $file -Force -ErrorAction SilentlyContinue }
    }

    It 'reports plain errors with where they happened' {
        $err = $null
        try { throw 'Unsupported operating system.' } catch { $err = $_ }
        $report = ConvertTo-ErrorReport -Step 'FATAL' -ErrorRecord $err
        $report.Summary | Should -Be 'Unsupported operating system.'
        $report.Command | Should -BeNullOrEmpty
        $report.Where | Should -Match 'Install\.Tests\.ps1 line \d+'
    }

    It 'Write-InstallLog and Add-LogText never throw when the log cannot be written' {
        $blocker = Join-Path ([IO.Path]::GetTempPath()) "blocker-$([guid]::NewGuid().ToString('N'))"
        Set-Content -LiteralPath $blocker -Value ''
        try {
            $script:LogFile = Join-Path $blocker 'sub/install.log'
            $script:LogWarned = $false
            { Write-InstallLog 'INFO' 'hello' 6>$null; Add-LogText 'x' 6>$null } | Should -Not -Throw
            $script:LogWarned | Should -BeTrue
        } finally {
            $script:LogFile = $null
            Remove-Item $blocker -Force -ErrorAction SilentlyContinue
        }
    }

    It 'writes a readable timeline to the log file' {
        $file = Join-Path ([IO.Path]::GetTempPath()) "log-$([guid]::NewGuid().ToString('N')).log"
        try {
            $script:LogFile = $file
            $script:LogStep = 'Docker'
            Write-InstallLog 'INFO' "Downloading https://u:pw@example.com/x"
            Add-Failure 'Docker' ([System.Management.Automation.ErrorRecord]::new([Exception]::new('Could not get lock /var/lib/dpkg/lock-frontend'), 'x', 'NotSpecified', $null))
            $text = Get-Content -LiteralPath $file -Raw
            $text | Should -Match 'INFO   Docker   Downloading https://\*\*\*:\*\*\*@example\.com/x'
            $text | Should -Match 'ERROR  Docker   Could not get lock'
            $text | Should -Match '\| Hint: Another package manager'
        } finally {
            $script:LogFile = $null; $script:LogStep = ''
            $script:Failures.Clear()
            Remove-Item $file -Force -ErrorAction SilentlyContinue
        }
    }
}
