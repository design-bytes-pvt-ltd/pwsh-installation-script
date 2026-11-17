import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { probeSystem, runInstall } from './core/orchestrator';
import { InstallOptions } from './core/types';

let mainWindow: BrowserWindow | null = null;
let activeController: AbortController | null = null;

function resolveModelsPath(): string {
  const packagedPath = path.join(process.resourcesPath, 'models.json');
  if (app.isPackaged && fs.existsSync(packagedPath)) return packagedPath;
  return path.resolve(__dirname, '../../../../models.json');
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
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  ipcMain.handle('system:probe', async () => {
    return probeSystem(resolveModelsPath());
  });

  ipcMain.handle('install:start', async (_event, options: InstallOptions) => {
    if (activeController) {
      activeController.abort();
    }
    activeController = new AbortController();
    const logDir = app.getPath('logs');
    const logPath = options.logPath ?? path.join(logDir, `install-${Date.now()}.log`);

    await runInstall(
      { ...options, logPath },
      (evt) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('install:event', evt);
        }
      },
      activeController.signal
    );
    activeController = null;
  });

  ipcMain.handle('install:cancel', () => {
    if (activeController) {
      activeController.abort();
      activeController = null;
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
