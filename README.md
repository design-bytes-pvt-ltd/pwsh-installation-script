# Docker + Ollama installer

`install.ps1` installs **Ollama**, pulls **Ollama models**, and installs **Docker Desktop** on Windows, macOS and Linux. It runs unattended and skips anything that is already installed.

| OS | Ollama | Docker |
|---|---|---|
| Windows 10/11 | winget, or the official `OllamaSetup.exe` if winget fails | Enables WSL2 if needed, then installs Docker Desktop with winget or the official installer |
| macOS (Apple silicon / Intel) | Official `Ollama-darwin.zip` → `/Applications` | Official `Docker.dmg` (asks for your password once) |
| Linux | Official `install.sh` | Docker Desktop on Ubuntu/Debian (and derivatives) and Fedora when the machine is x86_64, has KVM and a graphical session. Otherwise, or if the Desktop install fails, it installs **Docker Engine** from get.docker.com |

Default model: `qwen3:0.6b`.

## Requirements
- **Windows:** Windows PowerShell 5.1 (built in) or PowerShell 7+. The script restarts itself as Administrator.
- **macOS / Linux:** PowerShell 7+ (`pwsh`). See [Install PowerShell](https://learn.microsoft.com/powershell/scripting/install/installing-powershell). Linux also needs `curl` and `sudo`.

## Usage

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File .\install.ps1

# macOS / Linux
pwsh ./install.ps1
```

### Options

| Parameter | Description |
|---|---|
| `-Models <list>` | Models to pull, as an array or a comma-separated list. Default: `qwen3:0.6b` |
| `-SkipOllama` | Don't install Ollama |
| `-SkipModels` | Don't pull models |
| `-SkipDocker` | Don't install Docker |
| `-DockerEngine` | Linux only: install Docker Engine instead of Docker Desktop |
| `-WhatIf` | Dry run: print what would happen without changing anything |

Examples:

```powershell
pwsh ./install.ps1 -Models qwen3:0.6b,llama3.2
pwsh ./install.ps1 -SkipDocker
pwsh ./install.ps1 -WhatIf
```

At the end the script prints a summary and any follow-up steps, such as a reboot after enabling WSL2 or logging out and back in for docker group membership. It exits with code `1` if any step failed.

## Testing on other platforms
- **Linux (Engine fallback path):** `docker run --rm -it -v "$PWD:/w" mcr.microsoft.com/powershell pwsh /w/install.ps1 -WhatIf`. Drop `-WhatIf` for a real install inside the container.
- **Windows:** run in a Windows 10/11 VM, first with `-WhatIf` and then for real.
