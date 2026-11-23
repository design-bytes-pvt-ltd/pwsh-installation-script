import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { loadLaunchUrl } from './core/appConfig';
import { defaultLogDir, describeOptions, describeSystem, fileStamp, InstallLogger, pruneOldLogs } from './core/logger';
import { type InstallResources, probeSystem, runInstall } from './core/orchestrator';
import type { InstallOptions } from '../shared/types';

let mainWindow: BrowserWindow | null = null;
let activeController: AbortController | null = null;
/** The logger of the running install, or of the last one (for "Show log" / "Copy error report"). */
let currentLogger: InstallLogger | null = null;
let crashLogger: InstallLogger | null = null;
let lastCrashDialog = 0;
/** Set once the user chose to exit, so closing the window no longer asks about a running install. */
let quitting = false;

function appSource(): string {
  return `desktop app ${app.getVersion()} (Electron ${process.versions.electron}, Node ${process.versions.node})`;
}

/** The log that unexpected errors go to: the running install's, else a crash log. */
function loggerForCrash(): InstallLogger {
  if (activeController && currentLogger) return currentLogger;
  if (!crashLogger) {
    const dir = defaultLogDir();
    pruneOldLogs(dir);
    crashLogger = new InstallLogger(path.join(dir, `crash-${fileStamp(new Date())}.log`), {
      source: appSource(),
      system: describeSystem(),
      options: 'none (no install running)',
    });
  }
  return crashLogger;
}

/** Last-resort handler: log the error in full and tell the user where the details are. */
function handleCrash(kind: string, err: unknown, showDialog = true): void {
  try {
    const logger = loggerForCrash();
    const report = logger.crash(kind, err);
    console.error(`[${kind}]`, err);
    // At most one dialog every 10 s, so an error loop cannot flood the screen.
    if (showDialog && app.isReady() && Date.now() - lastCrashDialog > 10_000) {
      lastCrashDialog = Date.now();
      dialog.showErrorBox(
        'The installer hit an unexpected error',
        `${report.summary}${report.hint ? `\n\n${report.hint}` : ''}\n\nThe full details were saved to:\n${logger.filePath}`
      );
    }
  } catch (loggingError) {
    console.error('[crash handler failed]', loggingError, err);
  }
}

process.on('uncaughtException', (err) => handleCrash('Uncaught exception', err));
process.on('unhandledRejection', (reason) => handleCrash('Unhandled promise rejection', reason));
app.on('render-process-gone', (_event, _contents, details) => {
  if (details.reason !== 'clean-exit') {
    handleCrash('Window crashed', new Error(`The window's renderer process stopped (reason: ${details.reason}, exit code ${details.exitCode}).`));
  }
});
app.on('child-process-gone', (_event, details) => {
  if (details.reason !== 'clean-exit' && details.reason !== 'killed') {
    handleCrash(
      'Helper process crashed',
      new Error(`Electron ${details.type} process stopped (reason: ${details.reason}, exit code ${details.exitCode}).`),
      false
    );
  }
});

/** Validates an error report sent by the renderer (untrusted input). */
function sanitizeRendererError(raw: unknown): Error {
  const o = (raw ?? {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const err = new Error(text(o.message, 2000) || 'Unknown renderer error');
  err.name = 'RendererError';
  const where = text(o.source, 500);
  err.stack = `${err.name}: ${err.message}\n${text(o.stack, 8000)}${where ? `\n    at ${where}` : ''}`;
  return err;
}

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

/** A file shipped via extraResources; in dev it is read from the repo root (__dirname is app/dist/main). */
function resolveResourcePath(relativePath: string): string {
  const packagedPath = path.join(process.resourcesPath, relativePath);
  if (app.isPackaged && fs.existsSync(packagedPath)) return packagedPath;
  return path.resolve(__dirname, '../../..', relativePath);
}

function resolveModelsPath(): string {
  return resolveResourcePath('models.json');
}

/** The dev-container compose file and the ghcr.io credentials (packaged copy first, then the repo root in dev). */
function resolveInstallResources(): InstallResources {
  const credentialFiles = [path.resolve(__dirname, '../../../ghcr-credentials.json')];
  if (app.isPackaged) credentialFiles.unshift(path.join(process.resourcesPath, 'ghcr-credentials.json'));
  return { composePath: resolveResourcePath('containers/docker-compose.yml'), credentialFiles };
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
    if (quitting || !activeController || !mainWindow) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Keep installing', 'Cancel and quit'],
      defaultId: 0,
      cancelId: 0,
      message: 'An installation is still running.',
      detail: 'Quitting now may leave Ollama or Docker partly installed.',
    });
    // Either way the window stays open: cancelling stops the run, and the renderer then shows the
    // "Installation cancelled" page, whose Exit button closes the installer.
    event.preventDefault();
    if (choice !== 0) activeController.abort();
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
    const logDir = defaultLogDir();
    pruneOldLogs(logDir);
    const logger = new InstallLogger(path.join(logDir, `install-${fileStamp(new Date())}.log`), {
      source: appSource(),
      system: describeSystem(),
      options: describeOptions(options),
    });
    currentLogger = logger;
    try {
      await runInstall(
        options,
        (evt) => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('install:event', evt);
        },
        controller.signal,
        logger,
        resolveInstallResources()
      );
    } catch (err) {
      // runInstall reports step failures itself; anything reaching here is a bug.
      handleCrash('Installer error', err);
      throw err;
    } finally {
      // Only clear the controller if it still belongs to this run.
      if (activeController === controller) activeController = null;
    }
  });

  // The renderer never passes the URL: it comes from app-config.json in the main process.
  ipcMain.handle('app:launch', async () => {
    await shell.openExternal(loadLaunchUrl(resolveResourcePath('app-config.json')));
  });

  ipcMain.handle('app:quit', () => {
    quitting = true;
    activeController?.abort();
    app.quit();
  });

  ipcMain.handle('install:cancel', () => {
    activeController?.abort();
  });

  ipcMain.handle('install:show-log', () => {
    const file = currentLogger?.filePath;
    if (file && fs.existsSync(file)) shell.showItemInFolder(file);
  });

  ipcMain.handle('install:copy-report', () => {
    const text = currentLogger?.reportText() ?? '';
    if (!text) return false;
    clipboard.writeText(`${text}\nFull log: ${currentLogger?.filePath}\n`);
    return true;
  });

  ipcMain.handle('log:renderer-error', (_event, raw: unknown) => {
    handleCrash('Renderer error', sanitizeRendererError(raw), false);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
