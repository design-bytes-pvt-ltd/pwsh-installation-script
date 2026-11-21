# Docker + Ollama installer

A desktop app (Electron) that installs **Ollama**, pulls **Ollama models**, and installs **Docker Desktop** on Windows, macOS and Linux. You pick the models, then it runs unattended and skips anything that is already installed.

| OS | Ollama | Docker |
|---|---|---|
| Windows 10/11 | winget, or the official `OllamaSetup.exe` if winget fails | Enables WSL2 if needed, then installs Docker Desktop with winget or the official installer |
| macOS (Apple silicon / Intel) | Official `Ollama-darwin.zip` → `/Applications` | Official `Docker.dmg` |
| Linux | Official `install.sh` | Docker Desktop on Ubuntu/Debian (and derivatives) and Fedora when the machine is x86_64, has KVM and a graphical session. Otherwise, or if the Desktop install fails, it installs **Docker Engine** from get.docker.com |

Downloaded installers are checked before they run (Authenticode on Windows, `codesign` on macOS).

## Running the app
```sh
cd app
npm ci
npm start        # build and open the app
npm test         # unit and fixture tests
npm run dist     # build installers (nsis / dmg / AppImage) into app/release
```

Building needs Node 22. People who install the app need nothing else: no PowerShell, Node or `curl`.

### Administrator rights
Ollama and the model pulls run as the signed-in user. Docker (plus WSL2 on Windows) asks for administrator rights once:

| OS | Prompt |
|---|---|
| Windows | One UAC prompt |
| macOS | The macOS password dialog |
| Linux | pkexec (polkit), or sudo with a zenity/kdialog/ssh-askpass password dialog. Desktop distributions ship polkit. On a system with none of these, run the app as root |

## Choosing models
The first screen lists the models in [`models.json`](models.json) and tags each one for this machine:

- **recommended:** fits in the memory budget.
- **may be slow:** fits in RAM but runs partly or entirely on the CPU.
- **too large:** needs more memory than the machine has. The app asks for confirmation before pulling one.

The budget depends on the machine:

| Machine | Budget |
|---|---|
| NVIDIA GPU (`nvidia-smi`) or AMD GPU (`rocm-smi`) | GPU memory (VRAM) |
| Apple silicon | 65% of unified memory, about what Metal can use by default |
| Anything else (CPU) | 50% of RAM |

The largest recommended model is selected by default. **Reset to default** restores that selection.

Models that are already downloaded are marked `installed`. The app asks the running Ollama server for them, or reads `~/.ollama/models` (or `OLLAMA_MODELS`) if the server isn't running. Downloaded models that aren't in `models.json` appear at the end of the list. Selecting an installed model pulls it again, which only downloads changes if a newer version exists. Installed models don't count toward the "to download" total.

To add a model, add an entry to `models.json`:

```json
{ "name": "mistral:7b", "description": "Mistral 7B", "size_gb": 4.4, "min_memory_gb": 7 }
```

`name` is the Ollama tag and is the only required field. `size_gb` is the download size. `min_memory_gb` is the memory needed to run the model comfortably. If you leave it out, the app estimates it as `size_gb × 1.2 + 1`, rounded up. CI checks `models.json` against [`models.schema.json`](models.schema.json).

## Launch link

"Launch Enterprise Brain" on the Finish step opens `launchUrl` from `app-config.json` (repo root, bundled with the
app) in the default browser. Only `http`/`https` links are used; anything else falls back to `https://google.com`.
During development, `ENTERPRISE_BRAIN_URL` overrides the file. In an installed app the file is read on each click,
so it can be changed in the app's resources folder without a rebuild.

## Dev container (ghcr.io)

After Docker, the installer starts the dev container defined in `containers/docker-compose.yml`
(`ghcr.io/design-bytes-pvt-ltd/ubuntu-nix-hm:latest`). It starts Docker Desktop if needed, waits up to
3 minutes for it, signs in to ghcr.io, then runs `docker compose -p enterprise-brain pull` and `up -d`.

The image is private. The installer signs in with a read-only bot token:

- **Release builds:** write `ghcr-credentials.json` at the repo root before `npm run dist` (for example from CI
  secrets). It is gitignored and bundled through `extraResources`; see `ghcr-credentials.example.json`. Use a token
  with only the `read:packages` scope: anyone with the installer can extract it.
- **Development:** export `GHCR_USERNAME` and `GHCR_TOKEN`, or create the same file.
- **No credentials:** the step relies on an existing `docker login ghcr.io` on that computer.

The token is passed to `docker login` on stdin and masked in logs and error reports. Docker keeps the login,
so later `docker compose pull` updates work without signing in again.

## Logs
Only the 10 newest logs are kept.

| OS | Folder |
|---|---|
| Windows | `%APPDATA%\Docker + Ollama Installer\logs` |
| macOS | `~/Library/Logs/Docker + Ollama Installer` |
| Linux | `~/.config/Docker + Ollama Installer/logs` |

The summary screen has a **Show log file** button, and a **Copy error report** button when something failed. Files are named `install-<time>.log`, or `crash-<time>.log` for unexpected errors outside an install. Each log has:

1. **A header:** app version, OS, user, admin rights, and the chosen options.
2. **A timeline:** one line per event (`time  LEVEL  step  message`). `OUT` lines are command output, and `$ cmd` lines are commands run inside administrator scripts.
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

Passwords, tokens and `user:pass@` URLs are masked before anything is written. Writing the log never stops an install: if the file can't be written, the install carries on.

The expected report text is pinned by `app/src/main/core/__tests__/fixtures/error-report.json`. If you change the format, hints or masking in `app/src/main/core/errors.ts` on purpose, update that fixture too.

## Why Ollama is installed natively (not in Docker)
The native install uses the GPU on every OS: Metal on macOS, CUDA or ROCm on Windows and Linux. Docker Desktop on macOS can't pass the GPU through to containers. A native install also lets the app pull models right away instead of waiting for Docker to start, which often needs a reboot or a fresh login after installation.

Containers can still reach the native server at `http://host.docker.internal:11434`. With Docker Engine on Linux, add `--add-host=host.docker.internal:host-gateway` to `docker run`.

To run Ollama in a container anyway (for example on a Linux server), here is a reference command. **The app does not run it:**

```sh
docker run -d --name ollama --restart unless-stopped \
  -v ollama:/root/.ollama -p 11434:11434 ollama/ollama
# NVIDIA GPU (requires nvidia-container-toolkit): add --gpus all
# AMD GPU: use ollama/ollama:rocm and add --device /dev/kfd --device /dev/dri
docker exec ollama ollama pull qwen3:0.6b
```

## Testing on other platforms
Use **Dry run** on the first screen to walk through the steps without changing anything. For real installs, test in VMs:

- **Windows 11** as a standard (non-admin) user: there should be one UAC prompt, and the user ends up in the `docker-users` group.
- **Ubuntu desktop** as a non-root user: Ollama and Docker install with one password prompt.
- **macOS:** the password dialog appears for Docker.
