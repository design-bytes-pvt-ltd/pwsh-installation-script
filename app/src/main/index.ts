import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { probeSystem, runInstall } from './core/orchestrator';
import { InstallOptions } from './core/types';

let mainWindow: BrowserWindow | null = null;
let activeController: AbortController | null = null;
let lastLogPath: string | null = null;

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

function resolveModelsPath(): string {
  const packagedPath = path.join(process.resourcesPath, 'models.json');
  if (app.isPackaged && fs.existsSync(packagedPath)) return packagedPath;
  // Dev: __dirname is app/dist/main, and models.json sits at the repo root.
  return path.resolve(__dirname, '../../../models.json');
}

/** Rebuilds the options from untrusted IPC input instead of passing it through. */
function sanitizeOptions(raw: unknown): InstallOptions {
  const o = (raw ?? {}) as Record<string, unknown>;
  const models = Array.isArray(o.models) ? o.models : [];
  for (const m of models) {
    if (typeof m !== 'string' || !MODEL_NAME.test(m)) throw new Error(`Invalid model name: ${String(m)}`);
  }
  return {
    installOllama: o.installOllama === true,
    installDocker: o.installDocker === true,
    dockerEngineOnLinux: o.dockerEngineOnLinux === true,
    dryRun: o.dryRun === true,
    models: Array.from(new Set(models as string[])),
  };
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 780,
    minHeight: 580,
    title: 'Docker + Ollama Installer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Closing mid-install would orphan installers and leave tools half-installed.
  mainWindow.on('close', (event) => {
    if (!activeController || !mainWindow) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Keep installing', 'Cancel and quit'],
      defaultId: 0,
      cancelId: 0,
      message: 'An installation is still running.',
      detail: 'Quitting now may leave Ollama or Docker partly installed.',
    });
    if (choice === 0) event.preventDefault();
    else activeController.abort();
  });
}

app.whenReady().then(() => {
  ipcMain.handle('system:probe', async () => {
    return probeSystem(resolveModelsPath());
  });

  ipcMain.handle('install:start', async (_event, rawOptions: unknown) => {
    if (activeController) throw new Error('An installation is already running.');
    const options = sanitizeOptions(rawOptions);
    const controller = new AbortController();
    activeController = controller;
    const logPath = path.join(app.getPath('logs'), `install-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    lastLogPath = logPath;
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      await runInstall(
        options,
        (evt) => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('install:event', evt);
        },
        controller.signal,
        logPath
      );
    } finally {
      // Only clear the controller if it still belongs to this run.
      if (activeController === controller) activeController = null;
    }
  });

  ipcMain.handle('install:cancel', () => {
    activeController?.abort();
  });

  ipcMain.handle('install:show-log', () => {
    if (lastLogPath && fs.existsSync(lastLogPath)) shell.showItemInFolder(lastLogPath);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
