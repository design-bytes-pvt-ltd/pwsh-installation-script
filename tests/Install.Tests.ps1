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
