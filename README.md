# Docker + Ollama installer

`install.ps1` installs **Ollama**, pulls **Ollama models**, and installs **Docker Desktop** on Windows, macOS and Linux. It asks which models to pull, then runs unattended and skips anything that is already installed.

| OS | Ollama | Docker |
|---|---|---|
| Windows 10/11 | winget, or the official `OllamaSetup.exe` if winget fails | Enables WSL2 if needed, then installs Docker Desktop with winget or the official installer |
| macOS (Apple silicon / Intel) | Official `Ollama-darwin.zip` → `/Applications` | Official `Docker.dmg` (asks for your password once) |
| Linux | Official `install.sh` | Docker Desktop on Ubuntu/Debian (and derivatives) and Fedora when the machine is x86_64, has KVM and a graphical session. Otherwise, or if the Desktop install fails, it installs **Docker Engine** from get.docker.com |

## Choosing models
When it starts, the script lists the models in [`models.json`](models.json) and tags each one for this machine:

```
  Up/Down: move   Space: select   A: all/none   Enter: confirm   Esc: skip models
       Model                  Size  Fit           Status     Description
   [ ] qwen3:0.6b           0.5 GB  [recommended] installed  Qwen3 0.6B - tiny, fast general model
   ...
 > [✓] qwen2.5-coder:7b     4.7 GB  [recommended]            Qwen2.5 Coder 7B - code generation
   [ ] llama3.1:8b          4.9 GB  [recommended]            Llama 3.1 8B - capable general model
   [✓] qwen3:8b             5.2 GB  [recommended]            Qwen3 8B - capable general model with thinking
   [ ] gemma3:12b           8.2 GB  [may be slow]            Gemma 3 12B - large general model, image input
   [ ] gpt-oss:20b         14.0 GB  [too large]              gpt-oss 20B - OpenAI open-weight reasoning model
   [ ] qwen2.5:7b           4.4 GB  [recommended] installed  Downloaded earlier (not in models.json)
  2 selected (9.9 GB to download)
```

Models that are already downloaded are marked `installed`. The script asks the running Ollama server for them, or reads `~/.ollama/models` (or `OLLAMA_MODELS`) if the server isn't running. Downloaded models that aren't in `models.json` appear at the end of the list. Selecting an installed model pulls it again, which only downloads changes if a newer version exists. Installed models don't count toward the "to download" total.

| Key | Action |
|---|---|
| ↑ / ↓ (or `k` / `j`), Home, End, PgUp, PgDn | Move |
| Space | Select or clear the model under the cursor |
| `A` | Select all, or clear all if everything is selected |
| Enter | Pull the selected models |
| Esc | Skip pulling models |

The largest recommended model is selected when the menu opens, so pressing Enter right away pulls just that one. The script asks for confirmation before pulling a model tagged `too large`. If the window is too short, the list scrolls.

Hosts without a real console, such as the PowerShell ISE, get a numbered list instead. There you type numbers, ranges, `all` or `none`, for example `1,3` or `2-4`.

The tags compare each model's `min_memory_gb` with a memory budget for the machine:

| Machine | Budget |
|---|---|
| NVIDIA GPU (found with `nvidia-smi`) | GPU memory (VRAM) |
| Apple silicon | 65% of unified memory, about what Metal can use by default |
| Anything else (CPU) | 50% of RAM |

- **recommended:** fits in the budget.
- **may be slow:** fits in RAM but runs partly or entirely on the CPU.
- **too large:** needs more memory than the machine has.

There is no prompt if you pass `-Models` or if there is no interactive console (for example piped input, CI or `-NonInteractive`). Without a console the script pulls the default model. If `models.json` is missing, for example when the script is piped from a URL, it falls back to `qwen3:0.6b`.

To add a model, add an entry to `models.json`:

```json
{ "name": "mistral:7b", "description": "Mistral 7B", "size_gb": 4.4, "min_memory_gb": 7 }
```

`name` is the Ollama tag and is the only required field. `size_gb` is the download size. `min_memory_gb` is the memory needed to run the model comfortably. If you leave it out, the script estimates it as `size_gb × 1.2 + 1`.

## Desktop app and CLI
There are two front ends for the same install:

| | Desktop app (`app/`) | CLI (`install.ps1`) |
|---|---|---|
| For | People who want a GUI installer | Servers, CI and admins who want a one-liner |
| Engine | TypeScript, in `app/src/main/core/` (**canonical**) | PowerShell, kept in sync with the app |
| Needs | Nothing (Electron app) | PowerShell (built into Windows; `pwsh` on macOS/Linux) |

The model rules (tiers, the memory budget, the default model and the table order) must match. [`tests/fixtures/model-rows.parity.json`](tests/fixtures/model-rows.parity.json) is a shared contract: both the Pester tests and the app's vitest tests check against it in CI. If you change those rules, update both implementations and the fixture.

Both front ends ask for administrator rights only for the steps that need them. Ollama and the model pulls run as the signed-in user, and Docker (plus WSL2 on Windows) asks once through UAC, the macOS password dialog, or pkexec/zenity on Linux.

### Running the desktop app
```sh
cd app
npm ci
npm start        # build and open the app
npm test         # unit + parity tests
npm run dist     # build installers (nsis / dmg / AppImage) into app/release
```
The summary screen links to the log file (see [Logs](#logs)) and has a **Copy error report** button when something failed.

## Requirements
- **Windows:** Windows PowerShell 5.1 (built in) or PowerShell 7+. Ollama and models install as you. For the Docker step only, the script restarts itself as Administrator (one UAC prompt) and prints the combined summary in your original window.
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
| `-Models <list>` | Models to pull, as an array or a comma-separated list. Skips the prompt |
| `-ModelsFile <path>` | Model list to show in the prompt. Default: `models.json` next to the script |
| `-SkipOllama` | Don't install Ollama |
| `-SkipModels` | Don't pull models |
| `-SkipDocker` | Don't install Docker |
| `-DockerEngine` | Linux only: install Docker Engine instead of Docker Desktop |
| `-LogPath <path>` | Where to write the log file. Default: see [Logs](#logs) |
| `-WhatIf` | Dry run: print what would happen without changing anything |

Examples:

```powershell
pwsh ./install.ps1 -Models qwen3:0.6b,llama3.2
pwsh ./install.ps1 -SkipDocker
pwsh ./install.ps1 -WhatIf
```

At the end the script prints a summary and any follow-up steps, such as a reboot after enabling WSL2 or logging out and back in for docker group membership. It exits with code `1` if any step failed.

## Logs
The desktop app and the CLI write the same log format to the same folder. Only the 10 newest logs are kept.

| OS | Folder |
|---|---|
| Windows | `%APPDATA%\Docker + Ollama Installer\logs` |
| macOS | `~/Library/Logs/Docker + Ollama Installer` |
| Linux | `~/.config/Docker + Ollama Installer/logs` |

The files are named `install-app-<time>.log` (desktop app), `install-cli-<time>.log` (CLI) and `crash-<time>.log` (unexpected app errors outside an install). Each log has:

1. **A header:** app or PowerShell version, OS, user, admin rights, and the chosen options.
2. **A timeline:** one line per event (`time  LEVEL  step  message`). `OUT` lines are command output, and `$ cmd` lines are commands run inside root scripts.
3. **A summary:** each step's result and the next steps.
4. **One FAILURE REPORT per error,** for example:

```
================================================================================
 FAILURE REPORT 1 of 1: Docker
--------------------------------------------------------------------------------
 What failed   Command failed (exit code 100)
 Command       apt-get install -y /tmp/docker-ollama-ab12/docker-desktop-amd64.deb
 Exit code     100
 Elevated      yes (pkexec)
 Hint          Another package manager (apt or Software Updater) is running. Wait for it to finish, then retry.
 Last output (3 lines)
   | $ apt-get install -y /tmp/docker-ollama-ab12/docker-desktop-amd64.deb
   | E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 4123 (apt)
   | E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), is another process using it?
================================================================================
```

Passwords, tokens and `user:pass@` URLs are masked before anything is written. Writing the log never stops an install: if the file can't be written, you get one warning and the install carries on.

The report layout, hint table and masking rules are a shared contract, like the model rules. [`tests/fixtures/error-report.parity.json`](tests/fixtures/error-report.parity.json) is checked by both test suites, so update `app/src/main/core/errors.ts`, `install.ps1` and the fixture together.

## Why Ollama is installed natively (not in Docker)
The native install uses the GPU on every OS: Metal on macOS, CUDA or ROCm on Windows and Linux. Docker Desktop on macOS can't pass the GPU through to containers. A native install also lets the script pull models right away instead of waiting for Docker to start, which often needs a reboot or a fresh login after installation.

Containers can still reach the native server at `http://host.docker.internal:11434`. With Docker Engine on Linux, add `--add-host=host.docker.internal:host-gateway` to `docker run`.

To run Ollama in a container anyway (for example on a Linux server), here is a reference command. **This script does not run it:**

```sh
docker run -d --name ollama --restart unless-stopped \
  -v ollama:/root/.ollama -p 11434:11434 ollama/ollama
# NVIDIA GPU (requires nvidia-container-toolkit): add --gpus all
# AMD GPU: use ollama/ollama:rocm and add --device /dev/kfd --device /dev/dri
docker exec ollama ollama pull qwen3:0.6b
```

## Testing on other platforms
- **Linux (Engine fallback path):** `docker run --rm -it -v "$PWD:/w" mcr.microsoft.com/powershell pwsh /w/install.ps1 -WhatIf`. Drop `-WhatIf` for a real install inside the container.
- **Windows:** run in a Windows 10/11 VM, first with `-WhatIf` and then for real.
